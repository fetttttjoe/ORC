import { describe, expect, it } from 'bun:test'
import { ApprovalMode, type Origin } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { runOrigin } from './run-chat'
import { splitTool } from './split-tool'
import { ANALYZE_STEP_ROLE } from './strategies/grounded-plan'

// the proposing step runs inside its run's chat, so the split it proposes is stamped with that chat
const STEP_ORIGIN: Origin = runOrigin('run:t1:v1')
const p = { taskId: 't1', stepId: 's1', runToken: 'step:t1:s1:a1', role: 'worker', executor: 'api-loop', modelRef: 'fake/m', maxIterations: 5, origin: STEP_ORIGIN }
const config = { approvalPolicy: { default: ApprovalMode.manual, rules: [] }, maxDepth: 3 }
// ChildPlanStep requires skillRefs/dependsOn explicitly (no zod default — only toolRefs has one)
const step = { id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }

describe('task_split tool', () => {
  it('is not offered to a scout: the grounded analyze step grounds the plan, finalize_plan decomposes it', () => {
    const kernel = { proposeSplit: async () => ({ splitId: 'sp', childTaskId: 'c', gated: true }) }
    expect(splitTool({ kernel, config, p: { ...p, role: ANALYZE_STEP_ROLE } })).toEqual([])
    expect(splitTool({ kernel, config, p })).toHaveLength(1)
  })

  it('routes a valid proposal to kernel.proposeSplit with inherited parent-step refs and the step\'s own chat', async () => {
    const calls: unknown[] = []
    const origins: Origin[] = []
    const kernel = { proposeSplit: async (input: unknown, origin: Origin) => { calls.push(input); origins.push(origin); return { splitId: 'sp', childTaskId: 'c', gated: true } } }
    const tool = must(splitTool({ kernel, config, p })[0], 'task_split tool')
    expect(tool.name).toBe('task_split')
    const r = await tool.execute({ title: 'C', spec: 'work', plan: { steps: [step] } }, 'call_1')
    expect(r.isError).toBe(false)
    expect(r.output).toEqual({ splitId: 'sp', childTaskId: 'c', gated: true })
    expect(calls[0]).toMatchObject({ parentTaskId: 't1', toolCallId: 'call_1', parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 } })
    expect(origins[0]).toEqual(STEP_ORIGIN) // the child is proposed FROM the parent run's chat, not from nowhere
  })

  it('falls back to a generated id when the caller supplies no toolCallId', async () => {
    const calls: unknown[] = []
    const kernel = { proposeSplit: async (input: unknown) => { calls.push(input); return { splitId: 'sp', childTaskId: 'c', gated: true } } }
    const tool = must(splitTool({ kernel, config, p })[0], 'task_split tool')
    await tool.execute({ title: 'C', spec: 'work', plan: { steps: [step] } })
    expect(calls[0]).toMatchObject({ toolCallId: expect.any(String) })
  })

  it('two same-titled proposals in one turn get distinct ids (real toolCallId, no slug collision)', async () => {
    const calls: unknown[] = []
    const kernel = { proposeSplit: async (input: unknown) => { calls.push(input); return { splitId: 'sp', childTaskId: 'c', gated: true } } }
    const tool = must(splitTool({ kernel, config, p })[0], 'task_split tool')
    await tool.execute({ title: 'Same Title', spec: 'a', plan: { steps: [step] } }, 'call_a')
    await tool.execute({ title: 'Same Title', spec: 'b', plan: { steps: [step] } }, 'call_b')
    expect(calls[0]).toMatchObject({ toolCallId: 'call_a' })
    expect(calls[1]).toMatchObject({ toolCallId: 'call_b' })
  })

  it('returns isError (never throws) on invalid input and on kernel rejection', async () => {
    const kernel = { proposeSplit: async () => { throw new Error('split exceeds max depth 3') } }
    const tool = must(splitTool({ kernel, config, p })[0], 'task_split tool')
    expect((await tool.execute({ title: 'C' })).isError).toBe(true) // missing plan
    const r = await tool.execute({ title: 'C', spec: '', plan: { steps: [step] } }, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('depth')
  })
})
