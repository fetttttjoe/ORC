import type { PlanStep, ResolvedTool } from '@orc/contracts'
import { pathInZone, stepMayReconcile, stepMayVerify, toolError } from '@orc/contracts'
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
// The role-auditor skill contract's "any defect ⇒ signal failure" stays intact and unqualified.
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
  + 'excuses a defect in a file that is in scope. An empty list is not evidence of success. '
  + 'citingNotes lists every memory note citing a path this task changed — your heal-or-confirm candidates; '
  + 'drift flags lag uncommitted work and are NOT the candidate list. degraded lists why citingNotes came back '
  + 'null (memory unavailable) and is present ONLY when that measurement could not be made.'

// The citing-notes join, injected by the composition root (runtime.ts) because the kernel may not
// import plugins/memory — same seam shape as commit-tool's StampNote. Powers the auditor's
// heal-or-confirm candidate list: drift flags are measured against COMMITTED revisions, so at
// verify time (pre-commit) they lag the very work being audited — observed twice as 4/7
// post-commit drift before this existed.
export type CitingNotes = (paths: string[]) => Promise<Array<{ id: string; scope: string; title: string; sourceRevision: string | null }>>

// The model-facing name, spelled ONCE. It is an exact-set member in two suites that must agree with
// this definition (scoped-changes-tool.test.ts and cli/runtime.test.ts's finish-step surface), and
// a name spelled three times drifts on the first rename while both tests stay green about the old
// spelling. Exported rather than kept private for exactly those consumers.
export const SCOPED_CHANGES_TOOL_NAME = 'scoped_changes'

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
  citing?: CitingNotes
  p: { taskId: string; stepId: string; role: string }
}): ResolvedTool[] {
  const { kernel, citing, p } = opts
  // Registration gate, not an execute-time rejection: a visible tool that can only ever error gets
  // called anyway and burns an iteration per attempt (report_coverage learned this live).
  // TWO floors, each spelled once in contracts and shared with the tool that pairs with it:
  //  • stepMayVerify — the auditor's verify step, paired with memory_verify. What it audits.
  //  • stepMayReconcile — the kernel-appended finish step, paired with task_notes. The finish step
  //    reconciles this task's notes against what the task actually changed, and the changed paths
  //    are that second half; without them it would have to diff the shared worktree, which is the
  //    very false positive this tool exists to remove.
  // Both are both-terms predicates, so a planner-authored step named 'verify' or 'finish' still
  // gets nothing.
  if (!stepMayVerify(p) && !stepMayReconcile(p)) return []
  return [{
    ref: `kernel/${SCOPED_CHANGES_TOOL_NAME}`, name: SCOPED_CHANGES_TOOL_NAME,
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
        // deduped: multiple steps writing one file is one candidate lookup, not several
        const uniquePaths = [...new Set(changed.map(r => r.path))]
        const citingNotes = citing ? await citing(uniquePaths) : null
        // The `degraded` convention (shared with commit-tool.ts): an absent measurement is `null`
        // in its own field (citingNotes above) PLUS a reason in `degraded`, omitted when nothing
        // is degraded. Use a separate field (not floor) because floor should only have exec-writes
        // caveats, so a consumer can read `floor` without missing absence notes riding along.
        return { output: { paths, citingNotes, floor: FLOOR_NOTE, ...(citing ? {} : { degraded: [CITING_DEGRADED] }) }, isError: false }
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

// The `degraded` reason when the citing-notes join is absent. FLOOR_NOTE describes a real property
// of the measurement itself (exec writes are never captured) and stays as-is regardless of memory
// state; this describes an ABSENCE, so it belongs only in `degraded`, never merged into FLOOR_NOTE.
const CITING_DEGRADED = 'citingNotes unavailable (memory degraded) — name that loudly in your summary.'
