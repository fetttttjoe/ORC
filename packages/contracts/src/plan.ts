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
  // kernel-set on the grounded template's analyze+plan steps: they author memory notes and read
  // code but must not write source before the plan is approved. Optional (no default) so it adds
  // no key to the many steps that never set it. Not exposed on the plan-note write path, so an
  // agent cannot grant itself source writes — only the template sets it.
  readOnlySource: z.boolean().optional(),
})
export type PlanStep = z.infer<typeof PlanStep>

// matched values, never scattered literals: routing keys the runtime and M5a split path share.
// `sweep` names the auto-heal reactor's machine-drafted maintenance plan (cli/auto-heal.ts). It is
// its own strategy for exactly one reason: the kernel exempts it from the appended finish step
// (FINISH_EXEMPT_STRATEGIES) — a plan nobody requested must never park on a human it never asked —
// and nothing else in a one-step draft distinguishes it from an operator's quick task.
export const STRATEGY = { groundedPlan: 'grounded-plan', split: 'split', single: 'template:single', sweep: 'template:sweep' } as const

// step-id vocabulary lives in step-ids.ts (zero-import: the browser and every plugin need it)
export { STEP_ID, VERIFY_STEP_ID, COMMIT_STEP_ID, CHECKS_STEP_ID, CHECKS_EXECUTOR_REF, FINISH_STEP_ID, MASTERPLAN_NOTE_ID, type StepId } from './step-ids'
import { STEP_ID, VERIFY_STEP_ID, MASTERPLAN_NOTE_ID } from './step-ids'

// Step roles the system gives meaning to. `PlanStep.role` stays an open string on purpose — an
// extension may introduce its own role, and memoryRoleFor maps an unknown one to the default
// surface — so this is the KNOWN set, not a closed enum.
export const STEP_ROLE = {
  scout: 'scout', implementer: 'implementer', auditor: 'auditor', worker: 'worker',
  // kernel-set only (withCommitStep): a planner note named 'commit' freezes as implementer, so the
  // git_commit gate's role term keeps it unarmed.
  committer: 'committer',
  // kernel-set only (withFinishStep), same reasoning as committer: it arms task_notes/record_decision
  // on the appended finish step and nowhere a planner or split could claim it.
  finisher: 'finisher',
} as const

/**
 * May this step record a confirmation — `memory_verify`, and the `scoped_changes` list feeding it?
 * Any auditor may, except the grounded planner, which shares the role (PLAN_STEP_ROLE ===
 * STEP_ROLE.auditor) and has audited nothing.
 *
 * Excludes the planner by identity rather than requiring the id `verify`: under that older rule an
 * auditor step named anything else silently lost the tool and fell back to memory_write, whose
 * `body` is a full replace — a confirm is not a rewrite. Shared by both gates so they cannot drift.
 */
export const stepMayVerify = (p: { stepId: string; role: string }): boolean =>
  p.role === STEP_ROLE.auditor && p.stepId !== STEP_ID.plan

// The finish step's gate — BOTH terms, like the commit gate: the finisher role is kernel-set
// (withFinishStep, enforced by proposeSplit's reserved-role refusal), so a planner-authored step
// named 'finish' never arms task_notes/record_decision, and the role alone would arm them on a
// step a split claimed. Shared by every gate that keys on the finish step so they cannot drift.
export const stepMayReconcile = (p: { stepId: string; role: string }): boolean =>
  p.stepId === STEP_ID.finish && p.role === STEP_ROLE.finisher

// The shipped skills carrying each kernel-appended role contract: auditor+heal prose on the
// verify step, the commit contract on the commit step, the finish contract on the finish step.
// Named here because the freeze (kernel) appends the refs and `orc init` (cli) seeds the files —
// a literal spelled twice would drift. The PROSE lives in vault/skills/<name>/SKILL.md,
// operator-editable and audited via skill_loaded content-hash events; the kernel owns only WHICH
// steps carry them, so a planner can neither author nor remove a role contract.
export const ROLE_SKILL = { auditor: 'role-auditor', committer: 'role-committer', finisher: 'role-finisher' } as const

// Which `author.source` values satisfy the grounded plan-approval gate (Kernel.approvedPlanHash).
// OPERATOR-owned, and deliberately a file edit in .orc/config.json rather than anything a prompt
// can reach: with 'mcp' accepted, the agent driving the MCP surface can approve the very plans it
// authored — the same self-approval the toolset avoids structurally by shipping no approve tool.
// The default keeps 'cli' alone, which is what the gate has always accepted.
// There is deliberately NO 'web' member: a web-UI reply rides the actions layer's via-default and
// is recorded as 'cli', so a 'web' entry would name a door the log never stamps. If that
// attribution ever changes, this enum grows then — never before.
export enum GroundedApprovalDoor {
  cli = 'cli',
  mcp = 'mcp',
}

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
  // Every shape rule in the plan-rules table, swept over each step. A zone entry that is not ONE
  // glob is the rule this chokepoint was built for: a planner joined several globs with newlines
  // into a single entry, it passed every gate, the frozen fence then matched no real path, and two
  // steps were refused every write to their own files with no repair path. This is the ONE fatal
  // chokepoint — every plan version, from every entry point, is validated here before it is
  // appended — and the wording is plan-rules' planFieldViolations, the same table memory_write
  // refuses the authoring write with, so a shape mistake is refused identically at both boundaries
  // and the author reads the same sentence whichever one catches it. Steps carry no links/siblings of their own (that shape exists only for plan-notes
  // at authoring time), so those fields are empty here — only the shape rules that read `zone` fire.
  for (const s of plan.steps) {
    const v = planFieldViolations({ id: s.id, zone: s.zone, links: [], siblings: [] })
    for (const msg of v.shape) errors.push(`step '${s.id}': ${msg}`)
  }
  // A multi-step plan where EVERY step is parallel is a defect — it shipped twice in live testing,
  // with verify auditing a file draft had not written yet because the two ran in one wave.
  // Exempting plans that contain a '<VERIFY>' step does not work: that exemption is only reachable
  // when the verify step is itself unordered, which is the very defect.
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
