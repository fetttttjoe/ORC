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
//
// SANITIZED, because a scope is validated against MEMORY_ID_RE (`^[a-z0-9][a-z0-9-]*$`) and a split
// child's task id is `<parentUuid>.<stepId>.<toolCallId>` — dots, underscores and mixed case, none
// of which that pattern accepts. Raw interpolation meant every plan-scoped write below the root task
// was REJECTED at the schema boundary: ambient step capture warned and dropped the note, and
// consolidation then read an empty step list and promoted a contentless outcome note. A root task
// (a bare uuid) is unaffected — the transform is identity on ids that were already safe.
// ponytail: case is folded, so two ids differing only in case would share a scope. Not reachable
// with a uuid + a random tool-call id; hash the tail if task ids ever become case-significant.
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
}).extend({ zone: z.array(z.string().min(1)).max(16).default([]) })
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
  // the kernel refuses what the planning skill forbids: a multi-step plan where EVERY step is
  // parallel (no dependsOn anywhere) and nothing is a 'verify' step shipped once in live testing —
  // its verification ran in parallel with the work it verified, in one shared worktree
  if (plan.steps.length > 1
    && plan.steps.every(s => s.dependsOn.length === 0)
    && !plan.steps.some(s => s.id === VERIFY_STEP_ID))
    errors.push(
      `malformed plan shape: ${plan.steps.length} steps, all parallel (every dependsOn empty) and no '${VERIFY_STEP_ID}' step — declare dependencies between steps or add a final '${VERIFY_STEP_ID}' step`)
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
