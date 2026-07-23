import type { Plan } from '@orc/contracts'

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
    lines.push(`      model ${s.modelRef}${rate ? ` (${rate})` : ''} · ≤${s.maxIterations} iterations`
      + `${s.dependsOn.length ? ` · after ${s.dependsOn.join(', ')}` : ''}`
      + `${s.zone.length ? ` · writes fenced to ${s.zone.join(', ')}` : ''}`)
    const instr = s.instructions.length > 300 ? `${s.instructions.slice(0, 300)}…` : s.instructions
    for (const l of instr.split('\n')) lines.push(`      ${l}`)
  }
  return lines.join('\n')
}
