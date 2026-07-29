import type { PlanStep, ResolvedTool } from '@orc/contracts'
import { pathInZone, STEP_ROLE, toolError, VERIFY_STEP_ID } from '@orc/contracts'
import type { Kernel } from '../kernel'

// scoped_changes: the paths THIS task's own steps recorded writing, derived purely from the event
// log (Kernel.listTaskChangedPaths → taskChangedPaths), each classified against the DECLARED zones
// of this task's plan steps (contracts pathInZone — pure, fs-free).
//
// WHY IT EXISTS, and the ONLY thing it may be used for: the workspace tree is shared with sibling
// tasks, so a verify step that diffs the tree sees unrelated completed work and reports this task
// as having changed files it never touched. This projection answers scope MEMBERSHIP — "is this
// path mine?" — and nothing else.
//
// WHAT IT IS NOT (kept in the code, not only in the prompt, so the next reader cannot mistake it):
//  • NOT a diff. It is a FLOOR: writes made by exec commands (formatters, codegen, build steps) are
//    not captured, so a file this task really changed can be missing from it.
//  • NOT a verdict. It reports paths; correctness is still audited over the whole tree exactly as
//    before, and an empty scoped set is not evidence of success.
//  • NOT a gate exemption. It never licenses skipping `bun test` / `bun run typecheck`, and
//    "not in my scoped set" is never a reason to dismiss a defect in a file that IS in scope.
// AUDITOR_CONTRACT's "any defect ⇒ signal failure" stays intact and unqualified.
//
// Read-only: no writes, no shelling out, no git. taskId/stepId come from the injected step context
// `p`, never from model input, so the model cannot aim it at another task. Failures come back as
// toolError(e) rather than throwing.
const DESCRIPTION =
  'List the workspace paths THIS task\'s own steps (and its descendant split tasks\' steps) recorded writing, '
  + 'derived from the event log, each flagged inZone against the declared zones of this task\'s plan steps. '
  + 'Use it for ONE thing: telling your task\'s changes apart from sibling tasks\' unrelated work in the shared '
  + 'worktree — a working-tree diff is NOT scoped to your task. It EXCLUDES files changed by exec commands '
  + '(formatters, codegen, build steps), so it is a floor, not a complete diff: a file you changed can be missing '
  + 'from it. It reports paths, never verdicts. It NEVER licenses skipping the test/typecheck gate and NEVER '
  + 'excuses a defect in a file that is in scope. An empty list is not evidence of success.'

// One classified path, flattened per contributing step so each row names exactly who wrote it.
export interface ScopedChange {
  path: string
  taskId: string
  stepId: string | null
  tool: string
  inZone: boolean
  zoneMatched?: string
}

// The zones a path recorded by `stepId` of `taskId` is judged against:
//  • the writing step's OWN declared zone when the write came from this task's plan (the precise
//    question: did that step stay inside the fence it declared?);
//  • otherwise (a descendant split task's step, or a step id not in this task's plan) the union of
//    every declared zone of this task's plan steps — the widest thing this task was allowed to
//    touch. Widening rather than guessing: an out-of-zone flag the auditor cannot act on is worse
//    than none, and the audit's own correctness check does not depend on this classification.
// A step that declared no zone is unfenced, and pathInZone's empty-zone semantics (everything
// matches) carry that through unchanged. No plan on the log → nothing to classify against → inZone.
function zonesFor(steps: PlanStep[], ownTaskId: string, row: { taskId: string; stepId: string | null }): string[] {
  if (steps.length === 0) return []
  if (row.taskId === ownTaskId && row.stepId !== null) {
    const own = steps.find(s => s.id === row.stepId)
    if (own) return own.zone
  }
  // only steps that can WRITE define the fallback envelope: a readOnlySource step (the kernel-
  // appended commit tail, the grounded analyze/plan) declares zone [] because it never writes, and
  // letting that empty zone mean "the task is unfenced" would stop flagging every out-of-union
  // descendant write the moment autoCommit is on
  const writers = steps.filter(s => s.readOnlySource !== true)
  if (writers.some(s => s.zone.length === 0)) return [] // an unfenced WRITER means the task is unfenced
  return writers.flatMap(s => s.zone)
}

export function scopedChangesTool(opts: {
  kernel: Pick<Kernel, 'listTaskChangedPaths' | 'getPlan'>
  p: { taskId: string; stepId: string; role: string }
}): ResolvedTool[] {
  const { kernel, p } = opts
  // Registration gate, not an execute-time rejection: a visible tool that can only ever error gets
  // called anyway and burns an iteration per attempt (report_coverage learned this live).
  // Both terms are required. PLAN_STEP_ROLE === STEP_ROLE.auditor, so a bare role check would also
  // hand this to the grounded task's `plan` step, which has no scope to check and no changes of its
  // own; and a bare stepId check would hand it to any step a planner happened to name 'verify'.
  if (p.role !== STEP_ROLE.auditor || p.stepId !== VERIFY_STEP_ID) return []
  return [{
    ref: 'kernel/scoped_changes', name: 'scoped_changes',
    description: DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const [changed, plan] = await Promise.all([
          kernel.listTaskChangedPaths(p.taskId),
          kernel.getPlan(p.taskId),
        ])
        const steps = plan?.steps ?? []
        const paths: ScopedChange[] = changed.flatMap(row =>
          row.steps.map(contributor => {
            const zone = zonesFor(steps, p.taskId, { taskId: row.taskId, stepId: contributor.stepId })
            const inZone = pathInZone(row.path, zone)
            const zoneMatched = inZone ? zone.find(g => pathInZone(row.path, [g])) : undefined
            return {
              path: row.path, taskId: row.taskId, stepId: contributor.stepId, tool: contributor.tool,
              inZone, ...(zoneMatched ? { zoneMatched } : {}),
            }
          }))
        return { output: { paths, floor: FLOOR_NOTE }, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }]
}

// Repeated in the RESULT, not just the tool description: the caveat has to travel with the data an
// agent is looking at when it decides what to do next.
const FLOOR_NOTE =
  'Floor, not a diff: exec-driven writes (formatters, codegen) are not captured, so a changed file can be missing. '
  + 'Scope membership only — never a reason to skip bun test / bun run typecheck, and never a reason to dismiss a defect.'
