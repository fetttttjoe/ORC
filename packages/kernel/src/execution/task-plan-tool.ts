import { CHECKS_STEP_ID, COMMIT_STEP_ID, featureTag, FINISH_STEP_ID, stepMayReconcile, toolError, type ResolvedTool, NO_INPUT_SCHEMA } from '@orc/contracts'
import type { Kernel } from '../kernel'

export const TASK_PLAN_TOOL_NAME = 'task_plan'
export const TASK_PLAN_LIMITS = { instructionChars: 1_000 } as const

const KERNEL_STEP_IDS: ReadonlySet<string> = new Set([CHECKS_STEP_ID, FINISH_STEP_ID, COMMIT_STEP_ID])
const ELLIPSIS = '…'

const DESCRIPTION =
  `Read the plan this task carried out: its title, spec, the feature \`tag\` for claims about it (null when the title has no usable characters), and each plan step's id, title and instructions (cut to ${TASK_PLAN_LIMITS.instructionChars} characters). The kernel's own checks, finish and commit steps are not listed.`

const cut = (text: string): string =>
  text.length > TASK_PLAN_LIMITS.instructionChars ? `${text.slice(0, TASK_PLAN_LIMITS.instructionChars)}${ELLIPSIS}` : text

export function taskPlanTool(opts: {
  kernel: Pick<Kernel, 'getTask' | 'getPlan'>
  p: { taskId: string; stepId: string; role: string }
}): ResolvedTool[] {
  const { kernel, p } = opts
  if (!stepMayReconcile(p)) return []
  return [{
    ref: `kernel/${TASK_PLAN_TOOL_NAME}`, name: TASK_PLAN_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: NO_INPUT_SCHEMA,
    execute: async () => {
      try {
        const [task, plan] = await Promise.all([kernel.getTask(p.taskId), kernel.getPlan(p.taskId)])
        if (!task) throw new Error(`no task '${p.taskId}'`)
        const steps = (plan?.steps ?? [])
          .filter(s => !KERNEL_STEP_IDS.has(s.id))
          .map(s => ({ id: s.id, title: s.title, instructions: cut(s.instructions) }))
        return { output: { title: task.title, spec: task.spec, tag: featureTag(task.title), steps }, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }]
}
