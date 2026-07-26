import { test, expect } from 'bun:test'
import type { EventRecord } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { orphanedNotes, staleNotes } from './sweep'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

// orphanedNotes reads only e.kind + e.payload; eventFixture fills the rest of the record honestly.
const wrote = (taskId: string, id: string, links: string[] = []): EventRecord =>
  eventFixture({ kind: 'memory_written', payload: { note: { id, title: id, links: links.map(t => ({ id: t })) }, author: { source: 'agent', taskId } } })
const cli = (id: string): EventRecord =>
  eventFixture({ kind: 'memory_written', payload: { note: { id, title: id, links: [] }, author: { source: 'cli' } } })
const deleted = (id: string): EventRecord =>
  eventFixture({ kind: 'memory_deleted', payload: { id, scope: 'project', author: { source: 'cli' } } })

test('owned+unreferenced goes; adopted and referenced stay', () => {
  const events = [
    wrote(A, 'n1'),
    wrote(A, 'n2'),
    wrote(A, 'n4'),
    wrote(B, 'n2'),          // a live task re-wrote n2 -> adopted
    wrote(B, 'n3', ['n1']),  // a survivor links to n1 -> keep it
  ]
  expect(orphanedNotes(events, new Set([A])).map(n => n.id).sort()).toEqual(['n4'])
})

test('unparseable payloads are skipped, not fatal', () => {
  const events = [eventFixture({ kind: 'memory_written', payload: { garbage: true } }), wrote(A, 'n1')]
  expect(orphanedNotes(events, new Set([A])).map(n => n.id)).toEqual(['n1'])
})

test('already-deleted notes are not re-swept; cli/null-authored notes are never swept', () => {
  const events = [wrote(A, 'g1'), deleted('g1'), cli('c1')]
  expect(orphanedNotes(events, new Set([A]))).toEqual([])
})

// ---- staleNotes: the TTL half of the lifecycle ----

const NOW = '2026-07-24T00:00:00.000Z'
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

const noted = (
  id: string,
  over: { retention?: string; links?: string[]; scope?: string; ts?: string } = {},
): EventRecord => eventFixture({
  ts: over.ts ?? daysAgo(100),
  kind: 'memory_written',
  payload: {
    note: {
      id, title: id, scope: over.scope ?? 'project',
      retention: over.retention ?? 'expirable',
      links: (over.links ?? []).map(t => ({ id: t })),
    },
    author: { source: 'agent' },
  },
})
const read = (id: string, ts: string, scope = 'project'): EventRecord => eventFixture({
  ts, kind: 'memory_accessed', payload: { id, scope, mode: 'read', author: { source: 'agent' } },
})
const swept = (events: EventRecord[], days = 30): string[] =>
  staleNotes(events, { now: NOW, days }).map(n => n.id).sort()

test('only the author-marked expirable lane is swept, and only past the TTL', () => {
  const events = [
    noted('cold-expirable'),
    noted('cold-durable', { retention: 'durable' }),
    noted('fresh-expirable', { ts: daysAgo(3) }),
  ]
  expect(swept(events)).toEqual(['cold-expirable'])
})

test('a read inside the window keeps a note — last touch is write OR read, whichever is later', () => {
  const events = [noted('n1'), noted('n2'), read('n1', daysAgo(2))]
  expect(swept(events)).toEqual(['n2'])
})

test('an authored inbound link from a surviving note protects it — topology, not traffic', () => {
  const events = [noted('hub', { retention: 'durable', links: ['leaf'] }), noted('leaf'), noted('orphan')]
  expect(swept(events)).toEqual(['orphan'])
})

test('two stale notes cannot protect each other by linking to each other', () => {
  const events = [noted('a', { links: ['b'] }), noted('b', { links: ['a'] })]
  expect(swept(events)).toEqual(['a', 'b'])
})

test('a link only protects within its own scope', () => {
  const events = [
    noted('plan-hub', { scope: 'plan-t1', retention: 'durable', links: ['leaf'] }),
    noted('leaf'), // project scope: the plan-scoped hub's link does not reach it
  ]
  expect(swept(events)).toEqual(['leaf'])
})

test('deleted notes are gone already, and unparseable payloads are skipped', () => {
  const events = [noted('n1'), deleted('n1'), eventFixture({ kind: 'memory_written', payload: { garbage: true } })]
  expect(swept(events)).toEqual([])
})

test('an unusable timestamp fails safe — unknown age is never swept', () => {
  expect(swept([noted('n1', { ts: 'not-a-date' })])).toEqual([])
})

test('reports the observed use that justified the retirement', () => {
  const events = [noted('n1', { ts: daysAgo(90) }), read('n1', daysAgo(60))]
  expect(staleNotes(events, { now: NOW, days: 30 })).toEqual([
    { id: 'n1', scope: 'project', title: 'n1', hits: 1, lastTouchedAt: daysAgo(60) },
  ])
})

// The episodic tier pins retention to expirable, so the trail a run leaves behind is sweepable by
// construction — the TTL needs no convention or tag to recognize one.
test('an episodic note is a sweep candidate without anyone declaring it expirable', () => {
  const episodic = eventFixture({
    ts: daysAgo(100), kind: 'memory_written',
    payload: { note: { tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Step A' }, author: { source: 'agent' } },
  })
  expect(swept([episodic])).toEqual(['step-a'])
})

// A decomposition is per-task by construction, so the plan tier is sweepable like the episodic one.
// But a plan note is an APPROVED artifact: it must survive while its task can still be retried or
// audited, so candidacy waits until the owning task is terminal.
const planNote = (id: string, taskId: string, over: { ts?: string } = {}): EventRecord => eventFixture({
  ts: over.ts ?? daysAgo(100), kind: 'memory_written',
  payload: {
    note: { tier: 'plan', id, scope: `plan-${taskId}`, title: id, rationale: 'why' },
    author: { source: 'agent', taskId },
  },
})

test('a plan note is swept only once its owning task is terminal', () => {
  const events = [planNote('masterplan', 't1')]
  expect(swept(events)).toEqual([])
  expect(staleNotes(events, { now: NOW, days: 30, terminalTaskIds: new Set(['t1']) }).map(n => n.id)).toEqual(['masterplan'])
})

test('a terminal task’s plan notes still obey the TTL and the link protection', () => {
  const terminalTaskIds = new Set(['t1'])
  const fresh = staleNotes([planNote('masterplan', 't1', { ts: daysAgo(3) })], { now: NOW, days: 30, terminalTaskIds })
  expect(fresh).toEqual([]) // inside the window
  const linked = staleNotes(
    [planNote('subplan', 't1'), noted('live-hub', { retention: 'durable', scope: 'plan-t1', links: ['subplan'] })],
    { now: NOW, days: 30, terminalTaskIds },
  )
  expect(linked.map(n => n.id)).toEqual([]) // a surviving note links to it
})

// Plan notes written before the tier's retention default changed carry `retention: durable` in
// their payload, so a retention-only candidacy rule would keep every existing decomposition forever.
// The TIER is what makes a decomposition transient; retention records the author's intent.
test('a plan note stamped durable is still swept once its task is terminal', () => {
  const legacy = eventFixture({
    ts: daysAgo(100), kind: 'memory_written',
    payload: {
      note: { tier: 'plan', id: 'masterplan', scope: 'plan-t1', title: 'M', retention: 'durable', rationale: 'why' },
      author: { source: 'agent', taskId: 't1' },
    },
  })
  expect(swept([legacy])).toEqual([])
  expect(staleNotes([legacy], { now: NOW, days: 30, terminalTaskIds: new Set(['t1']) }).map(n => n.id)).toEqual(['masterplan'])
})
