// The freshness gate: is this task's existing grounding still true of the working tree, or does
// the analyze step have to go and look again?
//
// Pure by construction — no git, no store, no IO, no imports from plugins/memory. Everything it
// knows arrives through GroundingSource, which is a STRUCTURAL interface: plugins/memory (or a
// test's hand-written fake) satisfies it without importing this file, and this file never reaches
// back. That is what lets the decision be a function the port can compute ONCE inside a
// checkpoint and replay from the recorded output forever after.

export interface GroundingNoteRef { id: string; sourceRevision: string | null; paths: string[] }

export interface GroundingSource {
  head(): Promise<string | null>
  notes(): Promise<GroundingNoteRef[]>
  /** count of `paths` that differ from the WORKING TREE at `rev` (committed changes OR unstaged
   * edits — orc drifts notes by editing without committing, so it must be the working tree, not
   * `rev..HEAD`); 0 = unchanged; null = git could not answer */
  commitsSince(rev: string, paths: string[]): Promise<number | null>
  /**
   * The FILES under `paths` that changed in (rev..HEAD] — the narrowing behind the incremental
   * (mixed-verdict) analyze path: `[]` means git answered "nothing changed", `null` means git could
   * not answer. OPTIONAL on purpose: this is a structural interface, so every existing
   * implementation and hand-written test fake must keep satisfying it without changing, and the
   * gate's own currency rule never consults it (see decideGroundingFreshness — a note is fresh iff
   * its declared paths are unchanged at HEAD, and that is decided by commitsSince alone).
   */
  changedPaths?(rev: string, paths: string[]): Promise<string[] | null>
}

export interface GroundingVerdict {
  fresh: boolean
  reason: string
  /** the sha the gate compared against, so the event it produces is self-contained evidence */
  head: string | null
  current: { id: string; revision: string; why: string }[]
  stale: { id: string; revision: string | null; why: string }[]
}

const short = (rev: string): string => rev.slice(0, 8)

/**
 * The smallest correct gate. Every note lands in exactly one of `current`/`stale` carrying the
 * human-readable `why` that will appear in the event log, and `fresh` is "at least one note AND
 * zero stale notes".
 *
 * Two rules are deliberate, not incidental:
 *
 *  * It fails OPEN. An unresolvable HEAD or a commitsSince that returns null makes the note stale,
 *    never current — git being unavailable is the absence of evidence, and the cost of being wrong
 *    is asymmetric (a needless deep scan costs money; a skipped scan on stale notes plans against
 *    a codebase that no longer exists).
 *
 *  * It is PATH-AWARE, and a note that offers nothing to compare paths on is stale. plugins/memory
 *    /src/step.ts carries the in-code measurement: bare `sourceRevision === HEAD` scored 0 of 42
 *    notes current after two commits over eight files, while only 11 of 18 checkable notes had
 *    actually moved. Equality alone is a whole-corpus invalidation on any commit anywhere, so a
 *    pathless note gets no free pass from it — it is only current when its revision IS head.
 */
export async function decideGroundingFreshness(src: GroundingSource): Promise<GroundingVerdict> {
  const head = await src.head()
  const notes = await src.notes()

  if (notes.length === 0)
    return { fresh: false, reason: 'no grounding notes exist for this area yet — nothing to reuse', head, current: [], stale: [] }

  const current: GroundingVerdict['current'] = []
  const stale: GroundingVerdict['stale'] = []

  for (const n of notes) {
    if (head === null) {
      stale.push({ id: n.id, revision: n.sourceRevision, why: 'git could not resolve HEAD, so currency is unknown — unknown is never current' })
      continue
    }
    if (n.sourceRevision === null) {
      stale.push({ id: n.id, revision: null, why: 'records no sourceRevision — it was never grounded against a commit' })
      continue
    }
    const rev = n.sourceRevision
    // NO `rev === head` short-circuit: orc edits source WITHOUT committing, so a note written at the
    // current HEAD can still be stale against an UNSTAGED edit to its paths. Currency is decided only
    // by diffing the note's paths against the WORKING TREE — the same probe the read-time drift check
    // uses, so the gate and reads can never disagree about whether a note has drifted.
    if (n.paths.length === 0) {
      stale.push({ id: n.id, revision: rev, why: `declares no paths — nothing to diff against the working tree, so currency cannot be verified` })
      continue
    }
    const changed = await src.commitsSince(rev, n.paths)
    if (changed === null) {
      stale.push({ id: n.id, revision: rev, why: `git could not diff ${n.paths.length} declared path(s) against ${short(rev)} — unknown is never current` })
      continue
    }
    if (changed === 0) {
      // NB: no path LIST here (count only) — a REUSED note's paths must never appear in the directive
      // lest they leak into the scan scope; dbos-port's mixed-verdict test guards exactly that.
      current.push({ id: n.id, revision: rev, why: `its ${n.paths.length} declared path(s) are unchanged in the working tree since ${short(rev)}` })
      continue
    }
    stale.push({ id: n.id, revision: rev, why: `${changed} of its declared path(s) (${n.paths.join(', ')}) differ from the working tree since ${short(rev)}` })
  }

  const fresh = stale.length === 0
  const reason = fresh
    ? `all ${current.length} grounding note(s) are current at HEAD ${head}: ${current.map(c => c.id).join(', ')}`
    : `${stale.length} of ${notes.length} grounding note(s) are not provably current${head ? ` at HEAD ${head}` : ' (HEAD unknown)'}: ${stale.map(s => s.id).join(', ')}`
  return { fresh, reason, head, current, stale }
}
