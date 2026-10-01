import { AutoHealMode, CheckVerdict, ClaimState, errorMessage, KnowledgeToolName, STEP_ROLE, STRATEGY, type ClaimDrift, type PlanDraft } from '@orc/contracts'
import { DEFAULT_TEMPLATE_MODEL, singleStepDraft } from './plan-template'

export interface AutoHealDeps {
  mode: AutoHealMode
  debounceMs: number
  schedule: (fn: () => void | Promise<void>, ms: number) => () => void
  suspects: () => Promise<ClaimDrift[]>
  hasOpenSweep: () => Promise<boolean>
  draftSweep: (suspects: ClaimDrift[]) => Promise<void>
  warn: (message: string) => void
}

export const AUTO_SWEEP_TITLE = 'auto-heal: sweep drifted knowledge'
export const SWEEP_LISTED_IDS = 50

export function sweepSpec(suspects: readonly ClaimDrift[]): string {
  const listed = suspects.slice(0, SWEEP_LISTED_IDS).map(s => `${s.claim.id} (${s.claim.location})`)
  const more = suspects.length - listed.length
  const check = KnowledgeToolName.check
  return `Auto-drafted by the commit reactor: ${suspects.length} knowledge claim(s) read suspect after a commit. `
    + `Suspect claims: ${listed.join(', ')}${more > 0 ? ` … and ${more} more` : ''}. `
    + `For each claim, read the code at its anchors, then call ${check} with { id, verdict, why }: `
    + `'${CheckVerdict.holds}' when it still describes the code; '${CheckVerdict.false}' with a patch that retires the claim or changes it `
    + `(the ${check} patch field); '${CheckVerdict.unknown}' when you cannot tell. `
    + 'Never edit repository files and never run git commands. '
    + "If the budget runs out first, signal outcome 'partial' naming the ids still unchecked."
}

export const sweepPlanDraft = (spec: string, maxIterations: number): PlanDraft =>
  singleStepDraft({ title: AUTO_SWEEP_TITLE, spec }, DEFAULT_TEMPLATE_MODEL, [], maxIterations, STRATEGY.sweep, STEP_ROLE.auditor)

export const AUTO_HEAL_DEBOUNCE_MS = 120_000

export function createAutoHeal(deps: AutoHealDeps): { onCommitRecorded: () => void; close: () => void } {
  let cancel: (() => void) | null = null

  const run = async (): Promise<void> => {
    try {
      if (deps.mode !== AutoHealMode.draft) return
      const suspects = (await deps.suspects()).filter(d => d.state === ClaimState.suspect)
      if (suspects.length > 0 && !(await deps.hasOpenSweep())) await deps.draftSweep(suspects)
    } catch (err) {
      deps.warn(`auto-heal: reaction failed — ${errorMessage(err)}`)
    }
  }

  return {
    onCommitRecorded: () => {
      if (deps.mode === AutoHealMode.off) return
      cancel?.()
      cancel = deps.schedule(() => { cancel = null; return run() }, deps.debounceMs)
    },
    close: () => {
      cancel?.()
      cancel = null
    },
  }
}
