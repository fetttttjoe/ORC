import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, ScopeType, type EventRecord } from '@orc/contracts'
import { authorFixture, eventFixture, must, taskFixture } from '@orc/contracts/fixtures'
import { modelOf } from '../test-helpers'
import { NODE_KIND, TOUCHABLE, TouchableName, VIEW, ViewName } from '../wire'
import { readView, touchesOf, viewOf } from './registry'

const events: EventRecord[] = [
  eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 't1' }),
  eventFixture({ seq: 2, kind: EVENT_KIND.tool_call, taskId: 't1', payload: { toolName: 'x', input: {} } }),
]
const model = modelOf(events)
// every timeline read names a scope — there is no unscoped read of the log
const project = { type: ScopeType.project }

// readView is the door-facing read: every outcome is pinned
describe('readView', () => {
  // a door's name is a string until the enum says otherwise; 'nope' can never become a view
  it('answers 404 for a name that is no view at all', () => {
    expect(readView(model, 'nope', {})).toEqual({ ok: false, status: 404, error: 'unknown view: nope' })
  })

  it('answers 400 naming the offending field when params fail their schema', () => {
    const out = readView(model, VIEW.timeline, { scope: project, limit: 0 })
    expect(out.ok).toBe(false)
    expect(out).toMatchObject({ status: 400 })
    // the path tells a caller which field to fix
    if (!out.ok) expect(out.error).toStartWith('limit: ')
  })

  it('falls back to (root) when the failure has no field path', () => {
    const out = readView(model, VIEW.timeline, 42)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(400)
      expect(out.error).toStartWith('(root): ')
    }
  })

  // the resolved name rides out so a door never runs the enum lookup twice
  it('answers the view with its resolved name and the model seq a client orders its refetch against', () => {
    const out = readView(model, VIEW.timeline, { scope: project, kinds: [EVENT_KIND.tool_call] })
    expect(out).toEqual({ ok: true, name: VIEW.timeline, seq: 2, data: [expect.objectContaining({ seq: 2, kind: EVENT_KIND.tool_call })] })
  })

  // a scope with no other param is a whole read: the absent limit must not be the thing that fails
  it('parses params rather than trusting them: an absent limit still reads', () => {
    const out = readView(model, VIEW.timeline, { scope: project })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toHaveLength(2)
  })

  // empty kinds is no filter and the schema must agree: a lower bound would 400 an empty selection
  it('accepts an empty kinds list and answers the unfiltered tail', () => {
    const out = readView(model, VIEW.timeline, { scope: project, kinds: [] })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toHaveLength(2)
  })
})

describe('touchesOf', () => {
  // the whole table in registry order: a rule that stops firing disappears from here
  it('reports the queries one event makes stale, tagged with the read that owns them', () => {
    expect(touchesOf(eventFixture({ seq: 3, kind: EVENT_KIND.step_started, taskId: 't1' }), model))
      .toEqual([
        { name: VIEW.timeline, params: { scope: { type: ScopeType.project } } },
        { name: VIEW.timeline, params: { scope: { type: ScopeType.task, id: 't1', subtree: false } } },
        { name: VIEW.node, params: { id: 't1' } },
        { name: VIEW.transcript, params: { taskId: 't1' } },
        { name: VIEW.plans, params: { taskId: 't1' } },
        { name: VIEW.planNotes, params: { taskId: 't1' } },
      ])
  })

  it('names exactly the views as touchable, and nothing else', () => {
    expect([...TouchableName.options].sort()).toEqual([...ViewName.options].sort())
    expect(Object.keys(TOUCHABLE).sort()).toEqual(Object.keys(VIEW).sort())
  })
})

// the in-process read: typed params in, the value out, no status
describe('viewOf', () => {
  const held = modelOf([...events, eventFixture({ seq: 4, kind: EVENT_KIND.task_created, taskId: 'known', payload: { task: taskFixture({ id: 'known' }) } })])
  const sessions = { model: async () => held }

  it('answers the view value for a caller inside the process', async () => {
    expect(await viewOf(sessions, 'p1', VIEW.timeline, { scope: { type: ScopeType.project }, kinds: [EVENT_KIND.tool_call] }))
      .toEqual([expect.objectContaining({ seq: 2, kind: EVENT_KIND.tool_call })])
  })

  it('passes the view own null through — the subject does not exist, which is the route 404', async () => {
    expect(await viewOf(sessions, 'p1', VIEW.plans, { taskId: 'never-planned' })).toBeNull()
  })

  // identity is the only assertion that tells a deep-copying re-parse from none
  it('hands back the read model own value rather than a copy of it', async () => {
    const out = await viewOf(sessions, 'p1', VIEW.node, { id: 'known' })
    expect(out?.type === NODE_KIND.task ? out.task : null).toBe(must(held.state.tasks.get('known'), 'the folded task'))
  })
})
