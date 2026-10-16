import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { CHECKS_STEP_ID, COMMIT_STEP_ID, featureTag, FINISH_STEP_ID, STEP_ROLE, VERIFY_STEP_ID } from '@orc/contracts'
import { must, planFixture, stepFixture, taskFixture } from '@orc/contracts/fixtures'
import { TASK_PLAN_LIMITS, TASK_PLAN_TOOL_NAME, taskPlanTool } from './task-plan-tool'

const TASK = taskFixture({ id: 't1', title: 'Plan notes move to the kernel', spec: 'the spec' })
const Out = z.object({ title: z.string(), spec: z.string(), tag: z.string().nullable(), steps: z.array(z.object({ id: z.string(), title: z.string(), instructions: z.string() })) })

const fakeKernel = (steps = [
  stepFixture({ id: 'a', instructions: 'Why: because\n\ndo a' }),
  stepFixture({ id: 'b', instructions: 'x'.repeat(3_000) }),
  stepFixture({ id: CHECKS_STEP_ID }),
  stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.finisher }),
  stepFixture({ id: COMMIT_STEP_ID }),
]) => ({ getTask: async () => TASK, getPlan: async () => planFixture({ steps }) })

const finishCtx = { taskId: 't1', stepId: FINISH_STEP_ID, role: STEP_ROLE.finisher }

const run = async (p = finishCtx) => {
  const tools = taskPlanTool({ kernel: fakeKernel(), p })
  const tool = must(tools[0], 'task_plan registered')
  expect(tool.name).toBe(TASK_PLAN_TOOL_NAME)
  return Out.parse((await tool.execute({})).output)
}

describe('taskPlanTool', () => {
  it('returns the plan steps without the kernel-appended tail', async () => {
    const out = await run()
    expect(out.steps.map(s => s.id)).toEqual(['a', 'b'])
    expect(out.title).toBe(TASK.title)
    expect(out.spec).toBe(TASK.spec)
  })

  it('cuts a long instruction to the limit plus an ellipsis', async () => {
    const out = await run()
    expect(must(out.steps[1], 'b').instructions).toBe(`${'x'.repeat(TASK_PLAN_LIMITS.instructionChars)}…`)
    expect(must(out.steps[0], 'a').instructions).toBe('Why: because\n\ndo a')
  })

  it('carries the tag of the task title', async () => {
    expect((await run()).tag).toBe(featureTag(TASK.title))
  })

  it('registers nothing for a step that may not reconcile', async () => {
    for (const p of [{ ...finishCtx, stepId: 's1' }, { ...finishCtx, stepId: VERIFY_STEP_ID, role: STEP_ROLE.auditor }, { ...finishCtx, role: STEP_ROLE.worker }])
      expect(taskPlanTool({ kernel: fakeKernel(), p })).toEqual([])
  })

  it('reports an error rather than throwing when the task is unknown', async () => {
    const tool = must(taskPlanTool({ kernel: { getTask: async () => undefined, getPlan: async () => undefined }, p: finishCtx })[0], 'tool')
    expect((await tool.execute({})).isError).toBe(true)
  })
})
