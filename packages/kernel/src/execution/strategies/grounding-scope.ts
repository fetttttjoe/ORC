// The MIXED branch of the freshness gate, as pure functions.
//
// decideGroundingFreshness partitions the area's notes into current[] and stale[]. When BOTH are
// non-empty the old gate threw the current half away and paid for a full deep scan; everything in
// this file exists so that run can instead reuse the current notes as grounding and send the scout
// at the stale notes' paths only.
//
// Pure by construction — no IO, no git, no store, no imports from plugins. Every function here is a
// function of the RECORDED verdict and the RECORDED scope, which is what lets dbos-port compute the
// decision ONCE inside checkpoint('grounding') and re-render the identical directive, event and
// citation on every replay without touching git again.

import type { EventDraft } from '@orc/contracts'
import { Confidence, EVENT_KIND } from '@orc/contracts'
import type { GroundingVerdict } from './grounding-freshness'

/**
 * The recorded scan scope. `reused`/`rescan` are note ids; `paths` is the flat union the scout is
 * allowed to look at this run.
 *
 * `perNote` is the same information keyed by stale note, because the evidence event owes one gaps[]
 * entry per stale note naming the paths scoped FOR THAT NOTE — a flat union cannot answer that, and
 * re-deriving it later would mean re-probing git (the one thing this design forbids).
 *
 * `probed` records whether the optional changedPaths probe actually narrowed anything: true when at
 * least one stale note's scope came from the probe rather than from its declared paths. It is
 * evidence about the decision, not an input to it.
 */
export interface GroundingScope {
  reused: string[]
  rescan: string[]
  paths: string[]
  probed: boolean
  perNote: { id: string; paths: string[] }[]
}

/**
 * What the port learned about ONE stale note: the paths the note itself declares (always known —
 * the gate read them from the note ref) and, when the optional changedPaths probe answered, the
 * files git says actually moved. `changed: null` means the probe was absent or could not answer.
 *
 * The verdict deliberately does NOT carry declared paths (its shape is frozen — see
 * grounding-freshness.ts), so they travel here instead of widening it.
 */
export interface StalePathAnswer { declared: string[]; changed?: string[] | null }

/** A verdict that is not fresh but still has notes worth reusing — the incremental case. */
export const isMixed = (v: GroundingVerdict): boolean => !v.fresh && v.current.length > 0

/**
 * Build the scan scope from the verdict plus whatever the changedPaths probe answered per stale
 * note (id → files changed, or null/absent when git could not answer).
 *
 * Fallback rule, deliberately conservative: probe absent, probe returned null, or probe returned an
 * EMPTY list all fall back to that note's DECLARED paths. An empty answer is the one case worth
 * spelling out — the note is stale precisely because commitsSince counted commits on those paths,
 * so an empty diff means the two probes disagree, and the wider answer wins. Scoping to nothing
 * would silently ground the plan on a note nobody checked.
 *
 * A CURRENT note's paths never enter the scope: it is being reused, not re-derived.
 */
export function scanScope(v: GroundingVerdict, changed: Record<string, StalePathAnswer>): GroundingScope {
  const perNote: { id: string; paths: string[] }[] = []
  const seen = new Set<string>()
  const paths: string[] = []
  let probed = false
  for (const s of v.stale) {
    const answer = changed[s.id]
    const reported = answer?.changed ?? null
    const narrowed = reported !== null && reported.length > 0
    if (narrowed) probed = true
    const scoped = dedupe(narrowed ? reported : (answer?.declared ?? []))
    perNote.push({ id: s.id, paths: scoped })
    for (const p of scoped)
      if (!seen.has(p)) { seen.add(p); paths.push(p) }
  }
  return { reused: v.current.map(c => c.id), rescan: v.stale.map(s => s.id), paths, probed, perNote }
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)]

const revOf = (rev: string | null): string => rev ?? 'no-revision'

/**
 * The text handed to the scout as depOutputs.grounding. It has three jobs, in this order: name what
 * is already known (so the scout refines instead of re-deriving), name exactly what is in scope, and
 * say plainly that everything else is not.
 */
export function groundingDirective(v: GroundingVerdict, scope: GroundingScope): string {
  const head = v.head ?? 'unknown'
  const lines: string[] = [
    `INCREMENTAL GROUNDING — this analyze run is SCOPED. Compared against HEAD ${head}.`,
    ``,
    `ALREADY GROUNDED — reuse these notes, do NOT re-derive them:`,
    ...v.current.map(c => `  - ${c.id}@${c.revision} — ${c.why}`),
    `  memory_read the note ids above and treat them as this task's existing grounding. If one needs`,
    `  a correction, memory_write THE SAME ID (refine by id) — never write a competing note.`,
    ``,
    `RE-SCAN — these notes are stale; only the paths listed with them are in scope this run:`,
    ...v.stale.map(s => {
      const scoped = scope.perNote.find(p => p.id === s.id)?.paths ?? []
      return `  - ${s.id}@${revOf(s.revision)} — ${s.why}\n      in scope: ${scoped.length > 0 ? scoped.join(', ') : '(no paths resolved — scan what this note declares)'}`
    }),
    ``,
    `OUT OF SCOPE: the rest of the tree. ${scope.paths.length} path(s) are in scope in total`,
    `(${scope.paths.join(', ')}). Do not re-scan anything else — the reused notes above already cover it,`,
    `and they were verified against HEAD ${head}.`,
  ]
  return lines.join('\n')
}

/**
 * The evidence event for a mixed decision — one analysis_completed, built purely from the recorded
 * verdict and scope, so `orc log` answers "which notes were reused, which were re-scanned, and why"
 * without re-running anything.
 *
 * Safe to emit alongside the scout's own report_coverage: projections.ts folds analysis_completed as
 * traceability only and Kernel.latestCoverage takes the LAST one, so the scout's real report at the
 * end of the run supersedes this one.
 */
export function mixedGroundingDraft(v: GroundingVerdict, scope: GroundingScope, runToken: string): EventDraft {
  return {
    kind: EVENT_KIND.analysis_completed,
    payload: {
      analyzed: true,
      scope: v.current.map(c => `${c.id}@${c.revision} current at HEAD ${v.head} — ${c.why}`),
      gaps: [
        `incremental re-scan: only ${scope.paths.length} path(s) in scope (${scope.paths.join(', ')})`,
        ...v.stale.map(s => {
          const scoped = scope.perNote.find(p => p.id === s.id)?.paths ?? []
          return `${s.id}@${revOf(s.revision)} re-scanned — ${s.why} — paths scoped for it: ${scoped.join(', ') || '(none resolved)'}`
        }),
      ],
      confidence: Confidence.medium,
      notesWritten: 0,
    },
    idempotencyKey: `${runToken}:grounding:mixed:analysis_completed`,
  }
}

/**
 * The sentence the port appends to the step's completion summary on a mixed run. depOutputs[analyze]
 * is the plan step's ONLY grounding, so this is what makes that grounding complete by construction:
 * the reused notes are cited with their revisions and the compared HEAD even if the scout never
 * mentions them, and the plan step learns that the rest of the tree was not looked at this run.
 */
export function reusedCitation(v: GroundingVerdict, scope: GroundingScope): string {
  const reused = v.current.map(c => `${c.id}@${c.revision}`).join(', ')
  return `GROUNDING (added by the freshness gate, not by the scout): this analysis was INCREMENTAL. `
    + `Reused notes, verified current at HEAD ${v.head}: ${reused}. memory_read them — they are part of this step's grounding. `
    + `Only ${scope.paths.length} path(s) were re-scanned this run (${scope.paths.join(', ')}), for stale note(s) ${scope.rescan.join(', ')}; `
    + `nothing else in the tree was re-examined.`
}
