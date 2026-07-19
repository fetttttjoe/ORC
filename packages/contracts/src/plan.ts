import { z } from 'zod'
import { TOOL_REF_RE } from './plugins'

export const IsolationTier = z.enum(['local', 'worktree', 'docker'])
export type IsolationTier = z.infer<typeof IsolationTier>

export const ISOLATION_TIER = IsolationTier.enum

export const PlanStep = z.object({
  // path-safe: step ids flow into filesystem workspace paths and deterministic workflow ids
  id: z.string().regex(/^[\w-]+$/),
  role: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  executorRef: z.string().min(1),
  modelRef: z.string().min(1),
  skillRefs: z.array(z.string()),
  toolRefs: z.array(z.string().regex(TOOL_REF_RE)).default([]),
  isolation: IsolationTier,
  zone: z.array(z.string()),
  maxIterations: z.number().int().positive(),
  dependsOn: z.array(z.string()),
})
export type PlanStep = z.infer<typeof PlanStep>

// matched values, never scattered literals: routing keys the runtime and M5a split path share.
export const STRATEGY = { groundedPlan: 'grounded-plan', split: 'split', single: 'template:single' } as const

export const Plan = z.object({
  taskId: z.string().min(1),
  version: z.number().int().positive(),
  strategyRef: z.string().min(1),
  analyzerRef: z.string().min(1).optional(), // grounded-plan: which Analyzer seeds the graph (D2)
  costEstimateUSD: z.number().nonnegative().nullable(),
  steps: z.array(PlanStep).min(1),
})
export type Plan = z.infer<typeof Plan>

export const PlanDraft = Plan.omit({ taskId: true, version: true })
export type PlanDraft = z.infer<typeof PlanDraft>

// What the proposing agent authors in task_split (spec D3): a trimmed PlanDraft.
// executorRef/modelRef/isolation/zone/maxIterations are inherited from the parent step at expansion.
export const ChildPlanStep = PlanStep.omit({
  executorRef: true, modelRef: true, isolation: true, zone: true, maxIterations: true,
})
export type ChildPlanStep = z.infer<typeof ChildPlanStep>

export const ChildPlanDraft = z.object({ steps: z.array(ChildPlanStep).min(1) })
export type ChildPlanDraft = z.infer<typeof ChildPlanDraft>

export function validatePlan(plan: Plan): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const s of plan.steps) {
    if (ids.has(s.id)) errors.push(`duplicate step id: ${s.id}`)
    ids.add(s.id)
  }
  for (const s of plan.steps)
    for (const d of s.dependsOn)
      if (!ids.has(d)) errors.push(`step ${s.id} depends on unknown step: ${d}`)
  if (errors.length > 0) return { ok: false, errors }

  // ponytail: O(n^2) fixpoint cycle check — Kahn's with a real queue if plans get huge
  const remaining = new Map(plan.steps.map(s => [s.id, s.dependsOn]))
  const done = new Set<string>()
  let progress = true
  while (progress) {
    progress = false
    for (const [id, deps] of remaining) {
      if (deps.every(d => done.has(d))) {
        done.add(id)
        remaining.delete(id)
        progress = true
      }
    }
  }
  if (remaining.size > 0)
    errors.push(`dependency cycle involving: ${[...remaining.keys()].join(', ')}`)
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
