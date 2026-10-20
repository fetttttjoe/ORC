import { CHECKS_EXECUTOR_REF, MASTERPLAN_NOTE_ID, checkCommandsOf, errorMessage, type ChildPlanDraft, type Plan } from '@orc/contracts'
import { freezePlan, type Kernel } from '@orc/kernel'

// a named subset of Plan, so tests construct it cast-free
export type ReviewablePlan = Pick<Plan, 'version' | 'costEstimateUSD' | 'steps'>

// null = unknown ref or no discovery: the render omits the rate
export type ModelRate = (modelRef: string) => string | null

// plumbing (executorRef/isolation/strategyRef) stays behind --json
export function renderPlanHuman(plan: ReviewablePlan, rateFor?: ModelRate): string {
  const lines: string[] = []
  const est = plan.costEstimateUSD == null
    ? 'cost estimate: none provided — cost accrues per iteration at the rates below'
    : `cost estimate: $${plan.costEstimateUSD.toFixed(2)}`
  lines.push(`plan v${plan.version} · ${plan.steps.length} step(s) · ${est}`)
  for (const s of plan.steps) {
    const rate = rateFor?.(s.modelRef)
    lines.push(`  ${s.id}  [${s.role}] ${s.title}`)
    const after = s.dependsOn.length ? ` · after ${s.dependsOn.join(', ')}` : ''
    const commands = s.executorRef === CHECKS_EXECUTOR_REF ? checkCommandsOf(s.instructions) : null
    if (commands !== null) {
      lines.push(`      no model — runs these commands concurrently and reports; a failure never blocks${after}`)
      for (const c of commands) lines.push(`      $ ${c}`)
      continue
    }
    lines.push(`      model ${s.modelRef}${rate ? ` (${rate})` : ''} · ≤${s.maxIterations} iterations${after}`
      + `${s.zone.length ? ` · writes fenced to ${s.zone.join(', ')}` : ''}`)
    const instr = s.instructions.length > 300 ? `${s.instructions.slice(0, 300)}…` : s.instructions
    for (const l of instr.split('\n')) lines.push(`      ${l}`)
  }
  return lines.join('\n')
}

// what approving freezes: the plan hash binds approval to a graph the human must be shown
export function renderDerivedPlan(draft: ChildPlanDraft): string {
  const lines = ['what approving freezes (derived from the plan notes, not from the text above):']
  for (const s of draft.steps) {
    const order = s.dependsOn.length > 0 ? `after ${s.dependsOn.join(', ')}` : 'no dependencies — starts immediately'
    const zone = s.zone.length > 0 ? ` · writes ${s.zone.join(', ')}` : ''
    lines.push(`  ${s.id.padEnd(16)} ${order}${zone}`)
  }
  if (draft.steps.length > 1 && draft.steps.every(s => s.dependsOn.length === 0))
    lines.push(`  ! all ${draft.steps.length} steps are unordered and run at once`
      + ` — if the description above implies a sequence, the notes do not encode it`)
  return lines.join('\n')
}

// a freeze error is rendered, never thrown: the human needs to see it at the gate
export async function derivedPlanBlock(kernel: Pick<Kernel, 'listPlanNotes'>, opts: { autoCommit?: boolean; checks: readonly string[] }, taskId: string): Promise<string> {
  try {
    const notes = await kernel.listPlanNotes(taskId)
    if (!notes.some(n => n.id === MASTERPLAN_NOTE_ID)) return ''
    return renderDerivedPlan(freezePlan(MASTERPLAN_NOTE_ID, notes, opts))
  } catch (err) {
    return `the plan notes do not derive a runnable plan: ${errorMessage(err)}`
  }
}
