import { describe, expect, it } from 'bun:test'
import { DRIFT_STATE, EVENT_KIND, MemoryScope, NOTE_KIND, NOTE_TIER, type EventRecord } from '@orc/contracts'
import { recheckNotes } from './recheck'

// One spelling of the fixture corpus. The two drift-verdict cases below each name the note, its
// declared path and BOTH revisions, so a literal repeated per test is the drift this file's own
// subject matter is about — a probe keyed on 'old' while a stamp says 'olde' would pass silently.
const NOTE_ID = 'n'
const DECLARED_PATH = 'src/a.ts'
/** the revision the note was WRITTEN at — its declared path has moved since */
const WRITTEN_AT = 'old'
/** the revision an auditor CHECKED it at — nothing has moved since */
const CHECKED_AT = 'head'
const AT = '2026-08-02T00:00:00Z'

let seq = 0
const write = (note: Record<string, unknown>): EventRecord => ({
  seq: ++seq, ts: AT, taskId: null, stepId: null, runToken: null,
  kind: EVENT_KIND.memory_written, id: `e${seq}`,
  payload: { note: { tier: NOTE_TIER.semantic, kind: NOTE_KIND.fact, scope: MemoryScope.project, ...note }, author: { source: 'cli' } },
} as unknown as EventRecord)

const verify = (id: string, revision: string): EventRecord => ({
  seq: ++seq, ts: AT, taskId: null, stepId: null, runToken: null,
  kind: EVENT_KIND.memory_verified, id: `e${seq}`,
  payload: { id, scope: MemoryScope.project, stamp: { revision, at: AT, by: 'auditor' }, author: { source: 'cli' } },
} as unknown as EventRecord)

const deps = { changedSince: async () => new Set<string>(), terminalTaskIds: new Set<string>() }

// Revision-AWARE, which is the whole point of the two cases below: the declared path has moved
// since WRITTEN_AT and has not moved since CHECKED_AT. A probe reporting it moved for both would
// leave the note drifted — correctly — and prove nothing about the either-clean rule.
const movedSinceWrite = {
  changedSince: async (rev: string) => rev === WRITTEN_AT ? new Set([DECLARED_PATH]) : new Set<string>(),
  terminalTaskIds: new Set<string>(),
}

const drifting = { id: NOTE_ID, title: NOTE_ID, paths: [DECLARED_PATH], sourceRevision: WRITTEN_AT }

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
   * The END of the heal loop's CONFIRM branch, through the seam that actually reports it. The fold
   * dropped memory_verified entirely, so a note an auditor had confirmed against the tree still
   * came back `drifted` here — and archiveCandidates rules off this same list. Measured live on an
   * 84-note corpus before the fix: `orc memory recheck` said 30 drifted where health said 29, the
   * gap being the single note an auditor had just confirmed.
   */
  it('a verification clears drift, the same as it does on the read-model side', async () => {
    const unconfirmed = await recheckNotes([write(drifting)], movedSinceWrite)
    expect(unconfirmed[0].verdict).toBe(DRIFT_STATE.drifted)

    // same note, same tree — the only difference is that someone declared it checked
    const confirmed = await recheckNotes([write(drifting), verify(NOTE_ID, CHECKED_AT)], movedSinceWrite)
    expect(confirmed[0].verdict).toBe(DRIFT_STATE.clean)
  })

  /**
   * A verification asserts an auditor read THAT text. A later edit to what the note SAYS must drop
   * it, or the heal loop reports a check that never happened — the same CARRY-or-CLEAR rule
   * deriveNoteProvenance applies on the write path, asserted here through the fold.
   */
  it('an edit after a verification drops the stamp, so the note reads drifted again', async () => {
    const out = await recheckNotes(
      [write(drifting), verify(NOTE_ID, CHECKED_AT), write({ ...drifting, body: 'rewritten' })],
      movedSinceWrite,
    )
    expect(out[0].verdict).toBe(DRIFT_STATE.drifted)
  })
})
