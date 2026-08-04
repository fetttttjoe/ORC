import { DRIFT_STATE, LINK_KIND, NOTE_TIER, foldMemory, noteKey, type EventRecord } from '@orc/contracts'
import { noteDriftState, type ChangedSince } from './drift'
import type { NoteFacts, Verdict } from './archive'

// Gathers the facts archive.ts rules on: one pass over the knowledge log plus the tree, turning
// every live note into a NoteFacts. This is the "recalculate all the nodes" half — drift is
// computed on READ today (corpusDrift/noteDriftState) and thrown away, so nothing could ever act
// on it. Here each verdict is produced once, for every note, and handed to a policy.
//
// Split from archive.ts on purpose: that file is the rule table and imports nothing, this one owns
// the I/O (git probe, filesystem, the fold). Swapping either leaves the other untouched.

/**
 * Links that ASSERT OBSOLESCENCE rather than reference. They must never count as protection: a
 * note that supersedes another necessarily links to it, so counting that edge would make every
 * superseded note permanently protected by the very note replacing it — nothing would ever retire.
 */
const RETIRING_LINK: ReadonlySet<string> = new Set([LINK_KIND.supersedes, LINK_KIND.contradicts])

/** task-bound tiers: a plan or episodic note belongs to ONE task and dies with it */
const TASK_BOUND: ReadonlySet<string> = new Set([NOTE_TIER.plan, NOTE_TIER.episodic])

export interface RecheckDeps {
  changedSince: ChangedSince
  /** tasks that can no longer run — a task-bound note outlives its task only while it may be retried */
  terminalTaskIds: ReadonlySet<string>
}

export interface RecheckedNote extends NoteFacts {
  id: string
  scope: string
  title: string
  tier: string
  /** the stamp the verdict was measured from — null means nothing could be compared */
  sourceRevision: string | null
  /** what the note declares it describes — echoed so a report can show what a verdict was measured against */
  paths: readonly string[]
}

export async function recheckNotes(events: EventRecord[], deps: RecheckDeps): Promise<RecheckedNote[]> {
  const fold = foldMemory(events)
  // Already-archived notes stay in the FOLD — that is what makes a restore possible — but they are
  // not live knowledge and must never be re-offered as candidates: they would be re-reported and
  // re-archived on every pass, so the retirable count could never reach zero.
  const live = [...fold.notes.values()].filter(({ note }) => note.archived !== true)

  // inbound edges, split by what they MEAN — see RETIRING_LINK
  const retiredBy = new Map<string, string[]>()
  const inboundFrom = new Map<string, string[]>()
  for (const { note } of live) {
    const from = noteKey(note.scope, note.id)
    for (const link of note.links) {
      // a link names an id in the SAME scope as its author (scopes are not crossed by authored links)
      const target = noteKey(note.scope, link.id)
      const bucket = RETIRING_LINK.has(link.kind) ? retiredBy : inboundFrom
      const prior = bucket.get(target)
      if (prior) prior.push(from)
      else bucket.set(target, [from])
    }
  }

  const out: RecheckedNote[] = []
  for (const { note, author } of live) {
    const key = noteKey(note.scope, note.id)
    // `paths` exists on the semantic tier only, so the folded note is a union — read it the same
    // widened way corpusDrift does rather than narrowing per tier at every call site.
    const withPaths: { sourceRevision: string | null; paths?: readonly string[]; verified?: { revision: string } } = note
    const declared: readonly string[] = withPaths.paths ?? []
    const state = await noteDriftState(
      { sourceRevision: withPaths.sourceRevision, paths: declared, ...(withPaths.verified && { verified: withPaths.verified }) },
      deps.changedSince,
    )
    const taskId = author.taskId ?? ''
    out.push({
      key, id: note.id, scope: note.scope, title: note.title, tier: note.tier, paths: declared,
      sourceRevision: withPaths.sourceRevision,
      verdict: verdictOf(state),
      retiredBy: retiredBy.get(key) ?? [],
      // self-links would otherwise make a note its own protector
      inboundFrom: (inboundFrom.get(key) ?? []).filter(k => k !== key),
      taskSettled: TASK_BOUND.has(note.tier) && taskId !== '' && deps.terminalTaskIds.has(taskId),
    })
  }
  return out
}

/** DRIFT_STATE → archive.ts's zero-import string union, in one place so the two cannot drift apart */
const verdictOf = (s: string): Verdict =>
  s === DRIFT_STATE.drifted ? 'drifted' : s === DRIFT_STATE.unknown ? 'unknown' : 'clean'

/**
 * The corpus-level read-out a `recheck` prints, and what health can report without re-walking.
 *
 * `clean` counts notes whose declared paths were COMPARED and had not moved. It is not the whole of
 * `verdict === 'clean'`: noteDriftState also returns clean for a note carrying no sourceRevision or
 * no declared paths (the fail-toward-not-drifted rule), where nothing was compared at all. Those are
 * `uncheckable` — reporting them as current claims a verification nobody performed, which on the
 * live corpus meant 49 of 84 notes printed "current" against 5 actually checked.
 */
export interface RecheckSummary {
  total: number
  clean: number
  drifted: number
  unknown: number
  uncheckable: number
}

/** what the drift check needs to have anything to compare — the same pair corpusDrift requires */
const isCheckable = (n: RecheckedNote): boolean => n.sourceRevision !== null && n.paths.length > 0

export const summarize = (notes: readonly RecheckedNote[]): RecheckSummary => ({
  total: notes.length,
  clean: notes.filter(n => n.verdict === 'clean' && isCheckable(n)).length,
  drifted: notes.filter(n => n.verdict === 'drifted').length,
  unknown: notes.filter(n => n.verdict === 'unknown').length,
  uncheckable: notes.filter(n => n.verdict === 'clean' && !isCheckable(n)).length,
})
