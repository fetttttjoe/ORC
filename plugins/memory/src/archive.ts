// Which notes the graph may retire, decided from EVIDENCE OF OBSOLESCENCE. Pure and zero-import
// (the cluster.ts shape): the whole rule set is a table over facts the caller gathers, so it is
// testable without Surreal, without git and without a clock.
//
// WHY NOT AGE — the design change this file exists for.
// The TTL sweep this replaces retired on ELAPSED TIME, and that axis is wrong for
// archival: age measures neither correctness nor relevance. A note recording "Postgres listens on
// :5433" is correct for years, consulted rarely, and never changes — a TTL retires it precisely
// BECAUSE it is stable, which punishes the notes most worth keeping. docs/IDEAS.md entry 1 assumed
// that window; it was written when the corpus held zero notes, and every constant in it was a
// round number rather than a measurement. Nothing here reads a clock.
//
// The rule that makes it age-independent: a note whose declared paths have NOT moved is still
// true, so a `clean` verdict is never a candidate on any STALENESS ground, at any age. `unknown`
// fails safe the same way. The one thing that can retire a clean note is affirmative dead-end
// evidence (see the used-but-useless rule below) — truth and retrieval-worth are different axes.

/** the drift verdict, as DRIFT_STATE's values — a string union so this file imports nothing */
export type Verdict = 'clean' | 'drifted' | 'unknown'

export interface NoteFacts {
  key: string
  /** currency of the note's declared paths against the tree */
  verdict: Verdict
  /** keys of notes asserting supersedes/contradicts over this one */
  retiredBy: readonly string[]
  /** keys of notes that authored an inbound link to this one — its protectors */
  inboundFrom: readonly string[]
  /** a note bound to ONE task (plan/episodic tier) whose task has settled */
  taskSettled: boolean
  /** observed-use outcome counts (memory_outcome events), when any exist — counts only, no dates */
  use?: { useful: number; deadEnd: number }
}

// Same corroboration bar as contracts' MIN_CORROBORATION gives `preferred` — one report is an
// anecdote in either direction. A second spelling because this file imports nothing (the
// protector-rule comment below states the same trade for sweep.ts); change either and read both.
const DEAD_END_CORROBORATION = 2

export const ARCHIVE_REASON = {
  superseded: 'superseded',
  taskSettled: 'task-settled',
  deadEnd: 'dead-end',
} as const
export type ArchiveReason = (typeof ARCHIVE_REASON)[keyof typeof ARCHIVE_REASON]

/**
 * Why a note SURVIVED, when it otherwise looks retirable. Returned rather than dropped because
 * "why is this still here?" is the second question an operator asks, and a sweep that cannot
 * answer it never earns --apply.
 */
export const KEPT_BECAUSE = {
  current: 'declared paths unchanged — still true',
  unknown: 'currency could not be determined — failing safe',
  healable: 'drifted — the heal loop repairs this, it is not retirable',
  protected: 'a surviving note links to it',
  noEvidence: 'no evidence of obsolescence',
} as const
export type KeptBecause = (typeof KEPT_BECAUSE)[keyof typeof KEPT_BECAUSE]

export type Ruling =
  | { archive: true; reason: ArchiveReason; evidence: string }
  | { archive: false; kept: KeptBecause }

/**
 * One note's ruling. The ORDER is load-bearing:
 *
 *  1. A protector wins over everything, including an explicit supersedes. Retiring a note that a
 *     surviving note links to leaves that link dangling at a dead id, and repairing authored links
 *     is a stated non-goal (IDEAS entry 1, design fix 3) — so nothing may outrank it.
 *     sweep.ts's orphanedNotes states this same rule for the cancel sweep, and states it
 *     DIFFERENTLY: it counts every link, where the caller here excludes supersedes/contradicts (a
 *     superseding note links to what it replaces, and would otherwise protect it forever). Two
 *     spellings because this module imports nothing — change either and read both.
 *  2. `taskSettled` is a fact about the WORLD rather than about currency: a decomposition whose
 *     task is over is obsolete however current its steps' paths read.
 *
 * A third rule, `subject-deleted` (every declared path gone from the tree), was removed rather
 * than kept: notes declare DIRECTORIES and globs, which do not vanish, so it never once fired on a
 * real corpus while implying a coverage this file does not have. Proving a pattern matches nothing
 * is not something a cheap existence check can do, and a rule that cannot fire is worse than none.
 *
 * Note what is absent: hits, recency, and any clock. Coldness must never be candidacy — IDEAS
 * entry 1 fix 2, "activation ranks, it does not filter" — or a correct note untouched for 90 days
 * disappears exactly when someone returns to that area.
 */
export function rule(n: NoteFacts): Ruling {
  if (n.inboundFrom.length > 0) return { archive: false, kept: KEPT_BECAUSE.protected }

  if (n.retiredBy.length > 0)
    return { archive: true, reason: ARCHIVE_REASON.superseded, evidence: `retired by ${n.retiredBy.join(', ')}` }

  if (n.taskSettled)
    return { archive: true, reason: ARCHIVE_REASON.taskSettled, evidence: 'its task has settled and nothing links to it' }

  // The used-but-useless signal: agents PULLED this note and reported it wasted the step,
  // corroborated, with no useful report ever. Affirmative evidence, not coldness — a note nobody
  // pulls has use undefined/zeroes and can never match. Deliberately not gated on `verdict`: an
  // unchanged path proves a note still TRUE, and these reports say it is not worth RETRIEVING —
  // different axes, and truth without worth is the standing-hub disease. Any useful report makes
  // the disagreement contested, which is the heal loop's work, never retirement's.
  if (n.use && n.use.useful === 0 && n.use.deadEnd >= DEAD_END_CORROBORATION)
    return { archive: true, reason: ARCHIVE_REASON.deadEnd, evidence: `reported dead-end ${n.use.deadEnd} times, useful never` }

  // DRIFT IS NOT GROUNDS FOR RETIREMENT. It was, in an earlier draft of this file, and that was
  // wrong: drift is the INPUT to self-healing. The auditor's Heal rule reads every drifted note
  // against the tree and either rewrites it with the same id or confirms it via memory_verify —
  // so a drifted note is a note with recoverable knowledge and a subject that still exists.
  // Archiving it would discard exactly what the heal loop is there to repair, and the corpus would
  // shed knowledge instead of correcting it. Retirement is reserved for what healing CANNOT reach:
  // a note another has superseded, one whose subject was deleted, and task scaffolding whose task
  // is over. All three are checked above; anything left is the heal loop's work, not ours.
  return {
    archive: false,
    kept: n.verdict === 'clean' ? KEPT_BECAUSE.current
      : n.verdict === 'unknown' ? KEPT_BECAUSE.unknown
        : KEPT_BECAUSE.healable,
  }
}

export interface Candidate {
  key: string
  reason: ArchiveReason
  /** the fact that justified it — the dry run shows evidence, never a bare verdict */
  evidence: string
}

/**
 * The corpus, ruled at once.
 *
 * Protection resolves against SURVIVORS, so this iterates to a fixed point: retiring a note takes
 * its outbound links with it, which can expose notes it was the last protector of. A single pass
 * would retire a chain's head and leave its tail protected by a corpse — the same reasoning
 * sweep.ts's orphanedNotes applies, restated here because this file may not import it.
 */
export function archiveCandidates(notes: readonly NoteFacts[]): Candidate[] {
  const doomed = new Map<string, Candidate>()

  for (;;) {
    const before = doomed.size
    for (const n of notes) {
      if (doomed.has(n.key)) continue
      // a protector that is itself doomed protects nothing
      const r = rule({ ...n, inboundFrom: n.inboundFrom.filter(k => !doomed.has(k)) })
      if (r.archive) doomed.set(n.key, { key: n.key, reason: r.reason, evidence: r.evidence })
    }
    if (doomed.size === before) break
  }

  // input order, so one corpus always reports the same way
  return notes.flatMap(n => {
    const c = doomed.get(n.key)
    return c ? [c] : []
  })
}
