import { z } from 'zod'
import { TOOL_REF_RE } from './plugins'
import { planFieldViolations } from './plan-rules'

export enum IsolationTier {
  local = 'local',
  worktree = 'worktree',
  docker = 'docker',
}

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
  isolation: z.enum(IsolationTier),
  zone: z.array(z.string()),
  maxIterations: z.number().int().positive(),
  dependsOn: z.array(z.string()),
  // kernel-set only, never authored: the step writes no source; optional so other steps carry no key
  readOnlySource: z.boolean().optional(),
})
export type PlanStep = z.infer<typeof PlanStep>

// the sweep strategy skips the appended finish step (FINISH_EXEMPT_STRATEGIES)
export const STRATEGY = { groundedPlan: 'grounded-plan', split: 'split', single: 'template:single', sweep: 'template:sweep' } as const

// step-id vocabulary lives in step-ids.ts (zero-import: the browser and every plugin need it)
export { STEP_ID, VERIFY_STEP_ID, COMMIT_STEP_ID, CHECKS_STEP_ID, CHECKS_EXECUTOR_REF, FINISH_STEP_ID, MASTERPLAN_NOTE_ID, type StepId } from './step-ids'
import { STEP_ID, VERIFY_STEP_ID, MASTERPLAN_NOTE_ID } from './step-ids'

// the known set, not a closed enum: PlanStep.role stays an open string
export const STEP_ROLE = {
  scout: 'scout', implementer: 'implementer', auditor: 'auditor', worker: 'worker',
  // kernel-set only: a planner note named 'commit' freezes as implementer
  committer: 'committer',
  // kernel-set only (withFinishStep), same as committer
  finisher: 'finisher',
} as const

// the grounded planner shares the auditor role but has audited nothing
export const stepMayVerify = (p: { stepId: string; role: string }): boolean =>
  p.role === STEP_ROLE.auditor && p.stepId !== STEP_ID.plan

// The grounded plan step: it alone authors plan notes.
export const stepMayPlan = (p: { stepId: string; role: string }): boolean => p.stepId === STEP_ID.plan && p.role === STEP_ROLE.auditor

// both terms: a planner-authored step named 'finish' must not arm the finish gate
export const stepMayReconcile = (p: { stepId: string; role: string }): boolean =>
  p.stepId === STEP_ID.finish && p.role === STEP_ROLE.finisher

// the freeze appends these refs, orc init seeds the files; the kernel owns who carries them
export const ROLE_SKILL = { auditor: 'role-auditor', committer: 'role-committer', finisher: 'role-finisher' } as const

// operator-owned file edit: accepting 'mcp' would let the driving agent approve its own plans
export enum GroundedApprovalDoor {
  cli = 'cli',
  mcp = 'mcp',
}

export const Plan = z.object({
  taskId: z.string().min(1),
  version: z.number().int().positive(),
  strategyRef: z.string().min(1),
  analyzerRef: z.string().min(1).optional(), // grounded-plan: which Analyzer seeds the graph
  costEstimateUSD: z.number().nonnegative().nullable(),
  steps: z.array(PlanStep).min(1),
})
export type Plan = z.infer<typeof Plan>

export const PlanDraft = Plan.omit({ taskId: true, version: true })
export type PlanDraft = z.infer<typeof PlanDraft>

// task_split's trimmed PlanDraft; executor, model, isolation, maxIterations come from the parent
export const ChildPlanStep = PlanStep.omit({
  executorRef: true, modelRef: true, isolation: true, zone: true, maxIterations: true,
}).extend({
  zone: z.array(z.string().min(1)).max(16).default([]),
  modelRef: z.string().min(1).optional(), // the one inherited ref a child may override; absent = inherit
})
export type ChildPlanStep = z.infer<typeof ChildPlanStep>

export const ChildPlanDraft = z.object({ steps: z.array(ChildPlanStep).min(1) })
export type ChildPlanDraft = z.infer<typeof ChildPlanDraft>
// what CALLERS hand proposeSplit: defaults (zone) not yet applied — the kernel parses
export type ChildPlanDraftInput = z.input<typeof ChildPlanDraft>

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
  // the same rule table the authoring write refuses with, so both boundaries word a mistake alike
  for (const s of plan.steps) {
    const v = planFieldViolations({ id: s.id, zone: s.zone })
    for (const msg of v.shape) errors.push(`step '${s.id}': ${msg}`)
  }
  // an all-parallel multi-step plan is a defect: verify audited files draft had not yet written
  if (plan.steps.length > 1 && plan.steps.every(s => s.dependsOn.length === 0))
    errors.push(
      `malformed plan shape: ${plan.steps.length} steps, all parallel (every dependsOn empty) — declare dependencies between steps, e.g. a final '${VERIFY_STEP_ID}' step that dependsOn the work it checks`)
  // concurrent writers are refused at execution; ordering is what makes a shared zone safe
  const dependsOnAll = new Map(plan.steps.map(s => [s.id, new Set(s.dependsOn)] as const))
  for (let changed = true; changed;) {
    changed = false
    for (const [, deps] of dependsOnAll)
      for (const d of [...deps])
        for (const t of dependsOnAll.get(d) ?? [])
          if (!deps.has(t)) { deps.add(t); changed = true }
  }
  const ordered = (a: string, b: string): boolean =>
    (dependsOnAll.get(a)?.has(b) ?? false) || (dependsOnAll.get(b)?.has(a) ?? false)
  for (const [i, a] of plan.steps.entries())
    for (const b of plan.steps.slice(i + 1)) {
      if (ordered(a.id, b.id)) continue
      const shared = a.zone.filter(z => b.zone.includes(z))
      if (shared.length > 0)
        errors.push(`steps '${a.id}' and '${b.id}' can run concurrently and both declare zone ${shared.join(', ')} — order them with dependsOn, or give them separate zones`)
    }
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
