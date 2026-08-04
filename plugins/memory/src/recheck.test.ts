import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { recheckNotes } from './recheck'

let seq = 0
const write = (note: Record<string, unknown>): EventRecord => ({
  seq: ++seq, ts: '2026-08-02T00:00:00Z', taskId: null, stepId: null, runToken: null,
  kind: EVENT_KIND.memory_written, id: `e${seq}`,
  payload: { note: { tier: 'semantic', kind: 'fact', scope: 'project', ...note }, author: { source: 'cli' } },
} as unknown as EventRecord)

const deps = {
  dir: '/repo',
  changedSince: async () => new Set<string>(),
  terminalTaskIds: new Set<string>(),
  exists: (p: string) => p === '/repo/src/live.ts',
}

describe('recheckNotes', () => {
  /**
   * An archived note is still a memory_written, so it stays in the fold — that is what makes a
   * restore possible. But it must not come back as a CANDIDATE: it would be re-reported and
   * re-archived on every pass, so the retirable count could never fall to zero and `--apply` would
   * rewrite the same notes forever.
   */
  it('excludes notes that are already archived', async () => {
    const out = await recheckNotes([
      write({ id: 'live', title: 'live' }),
      write({ id: 'gone', title: 'gone', archived: true }),
    ], deps)
    expect(out.map(n => n.id)).toEqual(['live'])
  })

  /**
   * A declared path may be a GLOB (`plugins/memory/**` appears in this corpus). existsSync on one
   * is always false, so treating that as "the subject was deleted" would archive a live note
   * describing code that is very much there. Absence of a literal file is not evidence about a
   * pattern — fail safe.
   */
  it('never calls a glob path missing — that would retire notes about existing code', async () => {
    const out = await recheckNotes([write({ id: 'globbed', title: 'g', paths: ['plugins/memory/**'] })], deps)
    expect(out[0]?.subjectMissing).toBe(false)
  })

  it('still detects a genuinely deleted subject from literal paths', async () => {
    const out = await recheckNotes([write({ id: 'dead', title: 'd', paths: ['src/deleted.ts'] })], deps)
    expect(out[0]?.subjectMissing).toBe(true)
  })

  it('does not call a note missing when one of its literal paths still exists', async () => {
    const out = await recheckNotes([write({ id: 'partly', title: 'p', paths: ['src/live.ts', 'src/deleted.ts'] })], deps)
    expect(out[0]?.subjectMissing).toBe(false)
  })
})
