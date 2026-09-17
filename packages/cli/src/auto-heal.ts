import { AUTO_HEAL_MODE, STRATEGY, type AutoHealMode, type PlanDraft } from '@orc/contracts'
import { DEFAULT_TEMPLATE_MODEL, singleStepDraft } from './plan-template'

/**
 * The auto-heal reactor (knowledge provenance plan T2): what happens after the signal router
 * relays a recorded out-of-task commit. Debounce → the free restamp pass → and, under
 * 'draft-sweep', a DRAFTED heal task when drift survives — never an approved one, so the reactor
 * can spend exactly nothing on its own; the human's one-click approve stays the spend gate.
 *
 * Lives at the composition root because it crosses two domains the kernel keeps apart: the
 * memory store (restamp/drift) and the kernel (task drafting). Pure over injected deps — the
 * scheduler included, so the debounce contract is testable without wall-clock.
 */
export interface AutoHealDeps {
  mode: AutoHealMode
  debounceMs: number
  /** arm a timer; returns cancel. Injected: tests own the clock. */
  schedule: (fn: () => void | Promise<void>, ms: number) => () => void
  /** the free pass — restamp notes whose paths are fully committed; returns how many */
  restamp: () => Promise<number>
  /** drifted count AFTER the restamp — the sweep-worthiness measure */
  drifted: () => Promise<number>
  /** true when an auto-drafted sweep task is still open — one is the cap, never a queue */
  hasOpenSweep: () => Promise<boolean>
  /** draft (never approve) the sweep task, told how many notes drifted */
  draftSweep: (driftedCount: number) => Promise<void>
  warn: (message: string) => void
}

// The drafted task's title — the dedupe key hasOpenSweep matches on, so it is a constant, not
// prose composed at the call site.
export const AUTO_SWEEP_TITLE = 'auto-heal: sweep drifted knowledge'

// The drafted sweep's PLAN, built beside the title it belongs to: reactor drafts arrive
// plan-ready so the human's approve is genuinely one click (the operator used to have to
// `orc propose` the draft by hand first — observed 2026-08-04). `maxIterations` comes from
// config.memorySweepIterations, deliberately lean: a sweep that genuinely needs more signals
// `partial` and continues under the runtime's own continuation grants.
// STRATEGY.sweep, not the operator template: it is what exempts this plan from the kernel's
// appended finish step (FINISH_EXEMPT_STRATEGIES). The sweep is machine-drafted maintenance —
// nobody asked for it, so there is nobody waiting on its summary, and a finish step would park a
// self-drafted task on a human indefinitely.
export const sweepPlanDraft = (spec: string, maxIterations: number): PlanDraft =>
  singleStepDraft({ title: AUTO_SWEEP_TITLE, spec }, DEFAULT_TEMPLATE_MODEL, [], maxIterations, STRATEGY.sweep)

// Starting point, not a measurement: the log carries too few commit_recorded events to derive a
// cadence yet (2 as of 2026-08-03). The window's job is to make a rebase land as ONE reaction
// while a lone commit still reacts promptly. Re-derive from commit_recorded gaps once they exist
// in volume.
export const AUTO_HEAL_DEBOUNCE_MS = 120_000

export function createAutoHeal(deps: AutoHealDeps): { onCommitRecorded: () => void; close: () => void } {
  let cancel: (() => void) | null = null

  const run = async (): Promise<void> => {
    try {
      await deps.restamp()
      if (deps.mode !== AUTO_HEAL_MODE.draftSweep) return
      const drifted = await deps.drifted()
      // a failed restamp never reaches here (the catch below) — a sweep drafted on top of a
      // broken store would page the human about work the free pass may already cover
      if (drifted > 0 && !(await deps.hasOpenSweep())) await deps.draftSweep(drifted)
    } catch (err) {
      deps.warn(`auto-heal: reaction failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    onCommitRecorded: () => {
      if (deps.mode === AUTO_HEAL_MODE.off) return
      // every commit RESETS the window: a burst (rebase, stacked hand-commits) lands as one
      // reaction after the quiet period, not one per commit
      cancel?.()
      cancel = deps.schedule(() => { cancel = null; return run() }, deps.debounceMs)
    },
    close: () => {
      cancel?.()
      cancel = null
    },
  }
}
