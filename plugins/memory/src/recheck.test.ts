import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, ClaimClass, DRIFT_STATE, Door, EVENT_KIND, MEMORY_USE, MemoryScope, NOTE_KIND, NOTE_TIER, type ClaimInput, type EventRecord, type Origin } from '@orc/contracts'
import { recheckNotes, summarize } from './recheck'
import type { BlobsAt } from './claim-drift-read'
import { authorFixture, eventFixture } from '@orc/contracts/fixtures'

// An agent records an outcome inside its run's chat; MemoryAuthor.origin is required, and the
// untyped payload lets an author without it compile and then fail the parse at author.origin.
const RUN: Origin = { chatId: 'run:t1:v1', door: Door.supervisor }

// One spelling of the fixture corpus. The two drift-verdict cases below each name the note, its
// declared path and BOTH revisions, so a literal repeated per test is the drift this file's own
// subject matter is about — a probe keyed on 'old' while a stamp says 'olde' would pass silently.
const NOTE_ID = 'n'
const DECLARED_PATH = 'src/a.ts'
/** a second path the probe reports unmoved, so one note is genuinely checked-and-clean */
const OTHER_PATH = 'src/b.ts'
/** the revision the note was WRITTEN at — its declared path has moved since */
const WRITTEN_AT = 'old'
/** the revision an auditor CHECKED it at — nothing has moved since */
const CHECKED_AT = 'head'
const AT = '2026-08-02T00:00:00Z'

let seq = 0
const write = (note: Record<string, unknown>): EventRecord => eventFixture({
  seq: ++seq, ts: AT, kind: EVENT_KIND.memory_written,
  payload: { note: { tier: NOTE_TIER.semantic, kind: NOTE_KIND.fact, scope: MemoryScope.project, ...note }, author: authorFixture() },
})

const verify = (id: string, revision: string): EventRecord => eventFixture({
  seq: ++seq, ts: AT, kind: EVENT_KIND.memory_verified,
  payload: { id, scope: MemoryScope.project, stamp: { revision, at: AT, by: 'auditor' }, author: authorFixture() },
})

/** a path the fixture does not name is one the probe could not answer for, never a deletion */
const blobsOf = (blobs: Record<string, string | null>): BlobsAt => async paths => {
  const out = new Map<string, string | null>()
  for (const p of paths) {
    const seen = blobs[p]
    if (seen !== undefined) out.set(p, seen)
  }
  return out
}
const NO_BLOBS = blobsOf({})

const deps = { drift: { changedSince: async () => new Set<string>(), blobsAt: NO_BLOBS }, terminalTaskIds: new Set<string>() }

// Revision-AWARE, which is the whole point of the two cases below: the declared path has moved
// since WRITTEN_AT and has not moved since CHECKED_AT. A probe reporting it moved for both would
// leave the note drifted — correctly — and prove nothing about the either-clean rule.
const movedSinceWrite = {
  drift: {
    changedSince: async (rev: string) => rev === WRITTEN_AT ? new Set([DECLARED_PATH]) : new Set<string>(),
    blobsAt: NO_BLOBS,
  },
  terminalTaskIds: new Set<string>(),
}

const drifting = { id: NOTE_ID, title: NOTE_ID, paths: [DECLARED_PATH], sourceRevision: WRITTEN_AT }

const used = (id: string, outcome: string): EventRecord => eventFixture({
  seq: ++seq, ts: AT, kind: EVENT_KIND.memory_outcome,
  payload: { id, scope: MemoryScope.project, outcome, author: authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN }) },
})

describe('recheckNotes', () => {
  // The fold's outcome tallies reach the retirement rule as flat counts — and only when evidence
  // exists, so the common no-evidence corpus keeps `use` absent rather than zero-filled.
  it('threads observed-use outcome counts onto the facts archive.ts rules on', async () => {
    const out = await recheckNotes([
      write({ id: 'cited', title: 'cited' }),
      write({ id: 'quiet', title: 'quiet' }),
      used('cited', MEMORY_USE.useful),
      used('cited', MEMORY_USE.dead_end),
      used('cited', MEMORY_USE.dead_end),
    ], deps)
    expect(out.find(n => n.id === 'cited')?.use).toEqual({ useful: 1, deadEnd: 2 })
    expect(out.find(n => n.id === 'quiet')?.use).toBeUndefined()
  })

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

  /**
   * `clean` is not `checked`. noteDriftState returns clean for a note with no stamp OR no declared
   * paths (fail-toward-not-drifted), so counting it as current reports a verification nobody did —
   * measured on the live corpus: 49 of 84 notes declared zero paths and were printed "current"
   * while only 5 had actually been checked.
   */
  it('counts a never-checkable note apart from one that was checked and is current', async () => {
    const out = await recheckNotes([
      write({ ...drifting, id: 'checked-clean', paths: [OTHER_PATH] }),
      write(drifting),
      write({ id: 'pathless', title: 'pathless' }),
    ], movedSinceWrite)
    const s = summarize(out)
    expect(s.total).toBe(3)
    expect(s.drifted).toBe(1)
    expect(s.clean).toBe(1)        // only the one whose declared paths were actually compared
    expect(s.uncheckable).toBe(1)  // no stamp / no paths — nothing was compared at all
  })
})

const MOVED_CLAIM = 'a'.repeat(12)
const STILL_CLAIM = 'b'.repeat(12)
const claim = (id: string, anchors: { path: string; blob: string }[]): ClaimInput => ({
  id, text: `statement ${id}`, class: ClaimClass.fact, sourceRevision: WRITTEN_AT,
  anchors: anchors.map(a => ({ ...a, symbol: null })),
})

describe('recheckNotes judges a note that carries claims claim by claim', () => {
  it('names the one claim whose own file moved, not the whole note', async () => {
    const out = await recheckNotes([write({
      id: 'two-claims', title: 'two claims', paths: [],
      sourceRevision: WRITTEN_AT,
      claims: [claim(MOVED_CLAIM, [{ path: DECLARED_PATH, blob: 'blob-a1' }]), claim(STILL_CLAIM, [{ path: OTHER_PATH, blob: 'blob-b1' }])],
    })], {
      drift: { changedSince: async () => new Set<string>(), blobsAt: blobsOf({ [DECLARED_PATH]: 'blob-a2', [OTHER_PATH]: 'blob-b1' }) },
      terminalTaskIds: new Set<string>(),
    })
    expect(out[0].verdict).toBe(DRIFT_STATE.drifted)
    expect(out[0].suspectClaims).toEqual([MOVED_CLAIM])
    expect(out[0].unknownClaims).toEqual([])
  })

  it('is never drifted by a code change when every claim is unanchored', async () => {
    const out = await recheckNotes([write({
      id: 'unanchored', title: 'unanchored', paths: [DECLARED_PATH],
      sourceRevision: WRITTEN_AT,
      claims: [claim(MOVED_CLAIM, []), claim(STILL_CLAIM, [])],
    })], movedSinceWrite)
    expect(out[0].verdict).toBe(DRIFT_STATE.clean)
    expect(out[0].suspectClaims).toEqual([])
    expect(out[0].checkable).toBe(false) // nothing was compared — clean is not checked
  })

  it('a claim-free note still follows the note-path rule', async () => {
    const out = await recheckNotes([write(drifting)], movedSinceWrite)
    expect(out[0].verdict).toBe(DRIFT_STATE.drifted)
    expect(out[0].suspectClaims).toEqual([])
  })
})
