import { AutoHealMode, CheckVerdict, ClaimState, errorMessage, FS_LIST_TOOL_NAME, KnowledgeToolName, STEP_ROLE, STRATEGY, type ClaimAnchor, type ClaimDrift, type PlanDraft } from '@orc/contracts'
import { DEFAULT_TEMPLATE_MODEL, singleStepDraft } from './plan-template'

export interface AutoHealDeps {
  mode: AutoHealMode
  debounceMs: number
  schedule: (fn: () => void | Promise<void>, ms: number) => () => void
  suspects: (workspaceId: string | null) => Promise<ClaimDrift[]>
  hasOpenSweep: (workspaceId: string | null) => Promise<boolean>
  draftSweep: (workspaceId: string | null, suspects: ClaimDrift[]) => Promise<void>
  warn: (message: string) => void
}

export const AUTO_SWEEP_TITLE = 'auto-heal: sweep drifted knowledge'
export const SWEEP_LISTED_IDS = 50

const anchorRef = (a: Pick<ClaimAnchor, 'path' | 'symbol'>): string => `@${a.path}${a.symbol === null ? '' : `#${a.symbol}`}`

const listing = (d: ClaimDrift): string => `${[d.claim.id, ...d.claim.anchors.map(anchorRef)].join(' ')} (${d.claim.location})`

export function sweepSpec(suspects: readonly ClaimDrift[]): string {
  const listed = suspects.slice(0, SWEEP_LISTED_IDS).map(listing)
  const more = suspects.length - listed.length
  const check = KnowledgeToolName.check
  return `Auto-drafted by the commit reactor: ${suspects.length} knowledge claim(s) read suspect after a commit. `
    + `Suspect claims: ${listed.join(', ')}${more > 0 ? ` … and ${more} more` : ''}. `
    + `A folder anchor names a directory: list it with ${FS_LIST_TOOL_NAME} and never guess a file in it. Read each anchored file once. `
    + `A claim whose text states a number — a count, a size, a limit — holds only after you recount that exact number in the code; if the number no longer matches, correct the claim, never hold it as-is. `
    + `For each claim, read the code at its anchors, then call ${check} with { id, verdict, why }: `
    + `'${CheckVerdict.holds}' when it still describes the code; '${CheckVerdict.false}' with a patch that retires the claim or changes it `
    + `(the ${check} patch field); '${CheckVerdict.unknown}' when you cannot tell. `
    + 'Never edit repository files and never run git commands. '
    + "If the budget runs out first, signal outcome 'partial' naming the ids still unchecked."
}

export const sweepPlanDraft = (spec: string, maxIterations: number): PlanDraft =>
  singleStepDraft({ title: AUTO_SWEEP_TITLE, spec }, DEFAULT_TEMPLATE_MODEL, [], maxIterations, STRATEGY.sweep, STEP_ROLE.auditor)

export const AUTO_HEAL_DEBOUNCE_MS = 120_000

export function createAutoHeal(deps: AutoHealDeps): { onCommitRecorded: (workspaceId: string | null) => void; close: () => void } {
  let cancel: (() => void) | null = null
  const burst = new Set<string | null>()

  const react = async (workspaceId: string | null): Promise<void> => {
    try {
      const suspects = (await deps.suspects(workspaceId)).filter(d => d.state === ClaimState.suspect)
      if (suspects.length > 0 && !(await deps.hasOpenSweep(workspaceId))) await deps.draftSweep(workspaceId, suspects)
    } catch (err) {
      deps.warn(`auto-heal: reaction failed — ${errorMessage(err)}`)
    }
  }

  const run = async (): Promise<void> => {
    const workspaces = [...burst]
    burst.clear()
    if (deps.mode !== AutoHealMode.draft) return
    for (const workspaceId of workspaces) await react(workspaceId)
  }

  return {
    onCommitRecorded: workspaceId => {
      if (deps.mode === AutoHealMode.off) return
      burst.add(workspaceId)
      cancel?.()
      cancel = deps.schedule(() => { cancel = null; return run() }, deps.debounceMs)
    },
    close: () => {
      cancel?.()
      cancel = null
      burst.clear()
    },
  }
}
