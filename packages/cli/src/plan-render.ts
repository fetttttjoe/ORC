import { CHECKS_EXECUTOR_REF, checkCommandsOf, type ChildPlanDraft, type Plan } from '@orc/contracts'

// The review surface of a plan: exactly the fields a human weighs at the gate. A named subset
// (not the full Plan) so tests construct it cast-free and callers state their dependency.
export type ReviewablePlan = Pick<Plan, 'version' | 'costEstimateUSD' | 'steps'>

// Formats a model ref's price line ('$1/M in · $5/M out'). null = unknown ref or no discovery
// available (read-only context) — the render simply omits the rate.
export type ModelRate = (modelRef: string) => string | null

// Human-first render of the approval-gate artifact: what runs, on which model, at what rate,
// under what iteration budget, fenced where. Plumbing (executorRef/isolation/strategyRef)
// stays behind --json.
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

// What approving actually freezes. The gate used to show only the plan agent's prose, and the plan
// hash then bound the human's approval to a note graph they had never seen — a run shipped where
// the prose claimed a dependency the notes did not encode, and the steps raced.
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
