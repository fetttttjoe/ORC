import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, ScopeType, type EventRecord } from '@orc/contracts'
import { authorFixture, eventFixture, must, taskFixture } from '@orc/contracts/fixtures'
import { modelOf } from '../test-helpers'
import { NODE_KIND, TOUCHABLE, VIEW } from '../wire'
import { readView, touchesOf, viewOf } from './registry'

const events: EventRecord[] = [
  eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 't1' }),
  eventFixture({ seq: 2, kind: EVENT_KIND.tool_call, taskId: 't1', payload: { toolName: 'x', input: {} } }),
]
const model = modelOf(events)
// every timeline read names a scope — there is no unscoped read of the log
const project = { type: ScopeType.project }

// readView is the one door-facing read: everything a route needs to answer with is decided here,
// so each outcome is pinned rather than left to whichever door happens to call it first.
describe('readView', () => {
  // A door hands over a URL path segment, so a name is a string until the enum says otherwise.
  // 'nope' can never become a view, which keeps this case reachable once every view is implemented;
  // the same branch answers a name that IS on the wire but has no entry in the registry yet.
  it('answers 404 for a name that is no view at all', () => {
    expect(readView(model, 'nope', {})).toEqual({ ok: false, status: 404, error: 'unknown view: nope' })
  })

  it('answers 400 naming the offending field when params fail their schema', () => {
    const out = readView(model, VIEW.timeline, { scope: project, limit: 0 })
    expect(out.ok).toBe(false)
    expect(out).toMatchObject({ status: 400 })
    // the path is what tells a caller WHICH field to fix — an error that only said "invalid input"
    // sent the reader back to the schema
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

  // The resolved name rides out with the answer: a door that has to know WHICH view answered — to
  // offer something the log could not — would otherwise run the enum lookup a second time.
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

  // An empty kind set is NO filter, and the schema has to agree with the read: a lower bound here
  // would 400 a caller whose selection came out empty, where every other layer answers the tail.
  it('accepts an empty kinds list and answers the unfiltered tail', () => {
    const out = readView(model, VIEW.timeline, { scope: project, kinds: [] })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.data).toHaveLength(2)
  })
})

describe('touchesOf', () => {
  // The whole table in one answer, in registry order: this is what a client holds instead of the
  // event, so a read whose rule stops firing disappears from here and nowhere else.
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

  // Corpus health answers here without being a view: its read probes SurrealDB and git, so it has
  // no entry in WIRE and no `read` — only a staleness rule. A client that refetched it off the
  // browser's own event-kind table is exactly the disagreement this registry removes.
  const note = { note: { id: 'n', title: 'n', scope: 'project' }, author: authorFixture() }
  it('names corpus health as stale after a write, though it is no view', () => {
    const touched = touchesOf(eventFixture({ seq: 4, kind: EVENT_KIND.memory_written, taskId: null, payload: note }), model)
    expect(touched).toContainEqual({ name: TOUCHABLE.health, params: {} })
  })

  // A read moves `hits`, never currency, and preloads arrive at agent-loop cadence — health's read
  // is a whole-corpus git probe, so admitting this kind would put it on exactly that cadence.
  it('a memory READ leaves corpus health alone', () => {
    const read = eventFixture({ seq: 5, kind: EVENT_KIND.memory_accessed, taskId: null, payload: { id: 'n', scope: 'project', mode: 'read', author: note.author } })
    expect(touchesOf(read, model).map(t => t.name)).not.toContain(TOUCHABLE.health)
  })
})

// The second door-facing read: same views, but the caller already holds typed params and wants the
// value, not a status.
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

  // No re-parse on this path: a safeParse of the result would hand back a DEEP COPY of every
  // answer — a whole transcript, a 500-row log — to re-derive a shape the compiler already checked
  // at the call site. Identity is the only assertion that can tell the two apart.
  it('hands back the read model own value rather than a copy of it', async () => {
    const out = await viewOf(sessions, 'p1', VIEW.node, { id: 'known' })
    expect(out?.type === NODE_KIND.task ? out.task : null).toBe(must(held.state.tasks.get('known'), 'the folded task'))
  })
})
