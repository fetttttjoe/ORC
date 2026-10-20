import type { KnowledgeClaim, PlanStep, ResolvedTool } from '@orc/contracts'
import { errorMessage, KNOWLEDGE_DEFAULTS, KnowledgeToolName, pathInZone, stepMayReconcile, stepMayVerify, toolError, NO_INPUT_SCHEMA } from '@orc/contracts'
import type { Kernel } from '../kernel'

// Answers "is this path mine?" only: a floor from the log, never a diff, verdict or gate exemption.
const DESCRIPTION =
  'List the workspace paths THIS task\'s own steps (and its descendant split tasks\' steps) recorded writing, '
  + 'derived from the event log, each flagged inZone against the declared zones of this task\'s plan steps. '
  + 'Use it for ONE thing: telling your task\'s changes apart from sibling tasks\' unrelated work in the shared '
  + 'worktree — a working-tree diff is NOT scoped to your task. It EXCLUDES files changed by exec commands '
  + '(formatters, codegen, build steps), so it is a floor, not a complete diff: a file you changed can be missing '
  + 'from it. It reports paths, never verdicts. It NEVER licenses skipping the test/typecheck gate and NEVER '
  + 'excuses a defect in a file that is in scope. An empty list is not evidence of success. '
  + `citingClaims lists up to ${KNOWLEDGE_DEFAULTS.pageItems} recorded claims anchored at a path this task changed — your heal candidates: retire or change, with ${KnowledgeToolName.write}, each one the change made false. degraded lists why citingClaims came back null and is present ONLY when that measurement could not be made.`

// Exact-set member of two suites (this tool's and cli's runtime); spell it once.
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

// Widening rather than guessing: an out-of-zone flag the auditor cannot act on is worse than none.
function zonesFor(steps: PlanStep[], ownTaskId: string, row: { taskId: string; stepId: string | null }): string[] {
  if (steps.length === 0) return []
  if (row.taskId === ownTaskId && row.stepId !== null) {
    const own = steps.find(s => s.id === row.stepId)
    if (own) return own.zone
  }
  // Only writers define the fallback envelope: a readOnlySource step's empty zone is not "unfenced".
  const writers = steps.filter(s => s.readOnlySource !== true)
  if (writers.some(s => s.zone.length === 0)) return [] // an unfenced WRITER means the task is unfenced
  return writers.flatMap(s => s.zone)
}

export function scopedChangesTool(opts: {
  kernel: Pick<Kernel, 'listTaskChangedPaths' | 'getPlan'>
  claimsAt?: (paths: string[]) => Promise<KnowledgeClaim[]>
  p: { taskId: string; stepId: string; role: string }
}): ResolvedTool[] {
  const { kernel, claimsAt, p } = opts
  // Registration gate: a visible tool that can only error gets called anyway.
  if (!stepMayVerify(p) && !stepMayReconcile(p)) return []
  return [{
    ref: `kernel/${SCOPED_CHANGES_TOOL_NAME}`, name: SCOPED_CHANGES_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: NO_INPUT_SCHEMA,
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
        // `degraded` (as in commit-tool.ts): a null field plus a reason, kept apart from `floor`.
        const cited = claimsAt === undefined
          ? { citingClaims: null, degraded: [CITING_DEGRADED] }
          : await claimsAt(uniquePaths).then(
            claims => ({ citingClaims: claims, degraded: [] }),
            (err: unknown) => ({ citingClaims: null, degraded: [CITING_FAILED(errorMessage(err))] }))
        return { output: { paths, citingClaims: cited.citingClaims, floor: FLOOR_NOTE, ...(cited.degraded.length > 0 && { degraded: cited.degraded }) }, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }]
}

// Repeated in the RESULT: the caveat must travel with the data the agent is reading.
const FLOOR_NOTE =
  'Floor, not a diff: exec-driven writes (formatters, codegen) are not captured, so a changed file can be missing. '
  + 'Scope membership only — never a reason to skip bun test / bun run typecheck, and never a reason to dismiss a defect.'

// Absence reasons belong in `degraded` only, never in FLOOR_NOTE, which describes the measurement.
const CITING_DEGRADED = 'citingClaims unavailable (knowledge unavailable) — name that loudly in your summary.'
const CITING_FAILED = (reason: string): string => `citingClaims unavailable: ${reason}`
