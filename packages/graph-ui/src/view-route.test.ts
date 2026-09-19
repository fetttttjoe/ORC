import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { EVENT_KIND, ScopeType } from '@orc/contracts'
import { eventFixture, taskFixture } from '@orc/contracts/fixtures'
import { modelOf } from '@orc/ui-core/test-helpers'
import { VIEW, ViewEnvelope } from '@orc/ui-core/wire'
import { viewResponse } from './view-route'

// Pure over a hand-built read model: no server, no database. A route that needed either could not
// be exercised this way, which is as much the property under test as any assertion below.
const model = modelOf([
  eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 't1', payload: { task: taskFixture({ id: 't1' }) } }),
  eventFixture({ seq: 2, kind: EVENT_KIND.tool_call, taskId: 't1', payload: { toolName: 'x', input: {} } }),
])

const Err = z.object({ error: z.string() })
const body = async <S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> => schema.parse(await res.json())

const q = (params: unknown): string => JSON.stringify(params)

describe('the view route', () => {
  it('answers a view inside the envelope, with the seq a client orders its refetch against', async () => {
    const res = await viewResponse(model, VIEW.timeline, q({ scope: { type: ScopeType.project }, kinds: [EVENT_KIND.tool_call] }))
    expect(res.status).toBe(200)
    const env = await body(res, ViewEnvelope(z.array(z.object({ seq: z.number(), kind: z.string() }))))
    expect(env.seq).toBe(model.seq)
    expect(env.data).toEqual([{ seq: 2, kind: EVENT_KIND.tool_call }])
  })

  // The params are ONE url-encoded JSON value, so malformed JSON is a bad request — not a crash,
  // and not an empty answer that reads as "this project has nothing".
  it('400s on params that are not JSON', async () => {
    const res = await viewResponse(model, VIEW.timeline, '{not json')
    expect(res.status).toBe(400)
    expect((await body(res, Err)).error).toContain('q')
  })

  // A view whose params are all optional is asked for by name alone; the timeline is not one of
  // them — a read of the log always names its scope.
  it('treats an absent q as no params, rather than as a parse failure', async () => {
    const res = await viewResponse(model, VIEW.models, null)
    expect(res.status).toBe(200)
    expect((await body(res, ViewEnvelope(z.array(z.unknown())))).data).toHaveLength(0)
  })

  // A path segment is a string until the enum says otherwise — the same resolution readView does,
  // so a door can never answer under a name the browser was not told exists.
  it('404s a name that is no view', async () => {
    const res = await viewResponse(model, 'nope', null)
    expect(res.status).toBe(404)
    expect((await body(res, Err)).error).toContain('nope')
  })

  it('404s when the view says the subject does not exist', async () => {
    expect((await viewResponse(model, VIEW.plans, q({ taskId: 't1' }))).status).toBe(404)
  })

  // Naming the field is the whole point: an error that only said "invalid input" sent the reader
  // back to the schema to guess which param was wrong.
  it('400s params that fail their schema, naming the field', async () => {
    const res = await viewResponse(model, VIEW.timeline, q({ scope: { type: ScopeType.project }, limit: 0 }))
    expect(res.status).toBe(400)
    expect((await body(res, Err)).error).toStartWith('limit: ')
  })

  describe('a door answer for a view the log cannot fill', () => {
    const live = { [VIEW.models]: async () => ['p/live'] }

    it('answers it when the view came back empty', async () => {
      const res = await viewResponse(model, VIEW.models, null, live)
      expect(await body(res, ViewEnvelope(z.array(z.string())))).toEqual({ seq: model.seq, data: ['p/live'] })
    })

    // Once the log has something to say it wins, so a boot without provider credentials still
    // serves what was discovered.
    it('leaves a non-empty view alone', async () => {
      const discovered = modelOf([eventFixture({ seq: 1, kind: EVENT_KIND.models_discovered, taskId: null, payload: { providerId: 'p', models: ['logged'] } })])
      const res = await viewResponse(discovered, VIEW.models, null, live)
      expect((await body(res, ViewEnvelope(z.array(z.string())))).data).toEqual(['p/logged'])
    })

    it('leaves a view with no door answer empty', async () => {
      const res = await viewResponse(model, VIEW.models, null)
      expect((await body(res, ViewEnvelope(z.array(z.string())))).data).toEqual([])
    })
  })
})
