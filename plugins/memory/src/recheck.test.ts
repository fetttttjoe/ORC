import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { recheckNotes } from './recheck'

let seq = 0
const write = (note: Record<string, unknown>): EventRecord => ({
  seq: ++seq, ts: '2026-08-02T00:00:00Z', taskId: null, stepId: null, runToken: null,
  kind: EVENT_KIND.memory_written, id: `e${seq}`,
  payload: { note: { tier: 'semantic', kind: 'fact', scope: 'project', ...note }, author: { source: 'cli' } },
} as unknown as EventRecord)

const deps = { changedSince: async () => new Set<string>(), terminalTaskIds: new Set<string>() }

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



})
