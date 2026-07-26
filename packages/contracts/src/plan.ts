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

// The well-known ids and roles of a plan, in ONE place. They live in contracts rather than beside
// the grounded-plan strategy because both sides of the seam need them: the kernel stamps them, and
// plugins (the analyzer, the executor) match on them without being allowed to import the kernel.
// Splitting them was why 'masterplan', 'analyze', 'scout' and 'implementer' ended up as scattered
// literals — a plugin that cannot import the constant retypes the string.
//
// VERIFY_STEP_ID: validatePlan accepts it as the alternative to explicit dependencies, and the
// grounded freezer maps it to the auditor role.
export const STEP_ID = { analyze: 'analyze', plan: 'plan', verify: 'verify' } as const
export const VERIFY_STEP_ID = STEP_ID.verify

// The root of a grounded plan-note graph — what the authoring agent names, finalize_plan looks up,
// and the freezer decomposes from.
export const MASTERPLAN_NOTE_ID = 'masterplan'

// Step roles the system gives meaning to. `PlanStep.role` stays an open string on purpose — an
// extension may introduce its own role, and memoryRoleFor maps an unknown one to the default
// surface — so this is the KNOWN set, not a closed enum.
export const STEP_ROLE = {
  scout: 'scout', implementer: 'implementer', auditor: 'auditor', worker: 'worker',
} as const
export type StepRole = (typeof STEP_ROLE)[keyof typeof STEP_ROLE]

// The per-task plan-note scope. The authoring agent, finalize_plan, and every UI view derive
// it from the taskId — one format, one place (was duplicated as ui-core's planScopeName).
// Sanitized because a split child's id (`<uuid>.<stepId>.<toolCallId>`) carries dots and mixed case,
// which MEMORY_ID_RE rejects — every plan-scoped write below the root task was silently refused.
// ponytail: case is folded, so ids differing only in case would collide; hash the tail if that
// ever becomes reachable.
export const planScope = (taskId: string): string => `plan-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

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
// executorRef/modelRef/isolation/maxIterations are inherited from the parent step at expansion;
// zone is the child's OWN declaration (write-fence for parallel siblings) — default unfenced.
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
  // A multi-step plan where EVERY step is parallel shipped twice in live testing — verification
  // running alongside the work it verifies. This once exempted plans containing a '<VERIFY>' step,
  // but that exemption is only REACHABLE when the verify step is itself unordered, which is the
  // very defect: a plan froze `draft` and `verify` with no dependency, they ran in one wave, and
  // verify audited a file draft had not written yet.
  if (plan.steps.length > 1 && plan.steps.every(s => s.dependsOn.length === 0))
    errors.push(
      `malformed plan shape: ${plan.steps.length} steps, all parallel (every dependsOn empty) — declare dependencies between steps, e.g. a final '${VERIFY_STEP_ID}' step that dependsOn the work it checks`)
  // Concurrent writers to one path are refused mechanically at execution (the zone write-fence), so
  // a plan that schedules them is a defect the freeze can catch first. Ordering is what makes a
  // shared zone safe: if neither step transitively depends on the other, they can land in one wave.
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
