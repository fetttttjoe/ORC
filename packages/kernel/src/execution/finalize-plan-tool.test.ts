import { describe, expect, it } from 'bun:test'
import { COMMIT_STEP_ID, FINISH_STEP_ID, GroundedApprovalDoor, PlanNoteToolName, STEP_ID, STEP_ROLE, type PlanNote } from '@orc/contracts'
import { must, planNoteFixture } from '@orc/contracts/fixtures'
import { finalizePlanTool } from './finalize-plan-tool'
import { runOrigin } from './run-chat'
import { instantiateFrozenPlan, planGraphHash } from './strategies/grounded-plan'
import { withFinishStep } from '../finish-step'

// the planning step runs inside its run's chat, so the frozen split it proposes carries it
const p = { taskId: 't1', stepId: 'plan', runToken: 'step:t1:plan:a1', role: 'auditor', executor: 'api-loop', modelRef: 'anthropic/x', maxIterations: 30, origin: runOrigin('run:t1:v1') }
const config = { maxDepth: 3, finishChecks: [] }

const note = (over: Partial<PlanNote> & { id: string }): PlanNote => planNoteFixture({ title: over.id, ...over })
const finalizeFor = (opts: Parameters<typeof finalizePlanTool>[0]) => must(finalizePlanTool(opts)[0], 'finalize_plan tool')

// finalize_plan sources the frozen plan from kernel.listPlanNotes, a log fold the double models.
function fakeKernel(
  notes: PlanNote[], calls: unknown[] = [], approvedHash: string | null = planGraphHash(notes),
  nonHuman: { source: string } | null = null,
  doors: readonly string[] = [GroundedApprovalDoor.cli],
): Pick<import('../kernel').Kernel, 'proposeSplit' | 'listPlanNotes' | 'approvedPlanHash' | 'planNotesChangedSince' | 'nonHumanPlanApproval' | 'approvalDoors'> {
  return {
    approvalDoors: doors,
    listPlanNotes: async () => notes,
    approvedPlanHash: async () => (approvedHash === null ? null : { hash: approvedHash, seq: 1 }),
    planNotesChangedSince: async () => [],
    nonHumanPlanApproval: async () => nonHuman,
    proposeSplit: async (input: unknown) => { calls.push(input); return { splitId: 'sp', childTaskId: 'c', gated: false } },
  }
}

describe('finalize_plan tool', () => {
  it('freezes the log-reconstructed plan-note graph into an auto-approved split (task_split path)', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'Web app', body: 'the whole thing', subplans: ['db', 'api'] }),
      note({ id: 'db', title: 'DB', body: 'schema' }),
      note({ id: 'api', title: 'API', body: 'endpoints', dependsOn: ['db'] }),
    ]
    const calls: unknown[] = []
    const tool = finalizeFor({ kernel: fakeKernel(notes, calls), config, p })
    expect(tool.name).toBe(PlanNoteToolName.finalize)
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(false)
    expect(r.output).toEqual({ splitId: 'sp', childTaskId: 'c', gated: false })
    expect(calls[0]).toMatchObject({
      parentTaskId: 't1', stepId: 'plan', runToken: 'step:t1:plan:a1', toolCallId: 'call_1', title: 'Web app',
      policy: { default: 'auto' }, maxDepth: 3,
      parentStep: { executorRef: 'api-loop', modelRef: 'anthropic/x', maxIterations: 30 },
      // the freeze appends the finish step (withFinishStep); toMatchObject compares arrays by length
      plan: { steps: [{ id: 'db', role: 'implementer', dependsOn: [] }, { id: 'api', dependsOn: ['db'] }, { id: FINISH_STEP_ID, role: STEP_ROLE.finisher, dependsOn: ['db', 'api'] }] },
    })
  })

  it('rejects finalize when no matching human approval exists', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const result = await finalizeFor({ kernel: fakeKernel(notes, calls, null), config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.output)).toContain('approval')
    expect(calls).toHaveLength(0)
  })

  // A refusal must name the doors a HUMAN can use: the plan agent cannot type `orc reply` itself.
  it('no approval at all names the concrete human doors (orc reply + the web UI)', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const r = await finalizeFor({ kernel: fakeKernel(notes, calls, null), config, p }).execute({}, 'call_1')
    expect(r.isError).toBe(true)
    // exact text: names the accepted doors; `<taskId>` stays a placeholder (no real id in a prompt)
    expect((r.output as { error: string }).error).toBe(
      "finalize_plan requires human approval for this plan run (accepted approval doors: 'cli'), and none is recorded — ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI, then call finalize_plan again",
    )
    expect(calls).toHaveLength(0)
  })

  // An MCP-door approve is recorded but discarded: the refusal must name the door it came through.
  it('an approval from a non-human door says so, names that source, and still points at the human doors', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const r = await finalizeFor({ kernel: fakeKernel(notes, calls, null, { source: 'mcp' }), config, p }).execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect((r.output as { error: string }).error).toBe(
      "an approval for this plan run WAS recorded, but it arrived through the 'mcp' door, which is not among this project's accepted approval doors ('cli') — do not retry: ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI",
    )
    expect(calls).toHaveLength(0)

    // the source is READ FROM THE EVENT, not a hardcoded 'mcp' in the message builder
    const agent = await finalizeFor({ kernel: fakeKernel(notes, calls, null, { source: 'agent' }), config, p }).execute({}, 'call_2')
    expect(agent.isError).toBe(true)
    expect(JSON.stringify(agent.output)).toContain('agent')
    expect(JSON.stringify(agent.output)).not.toContain('mcp')
    expect(calls).toHaveLength(0)
  })

  // The refusal quotes the kernel's CONFIGURED doors, the same list the gate tests, never a literal.
  it('the refusal names the operator-configured door set, not a hardcoded one', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const doors = [GroundedApprovalDoor.cli, GroundedApprovalDoor.mcp]
    const none = await finalizeFor({ kernel: fakeKernel(notes, [], null, null, doors), config, p }).execute({}, 'call_1')
    expect((none.output as { error: string }).error).toBe(
      "finalize_plan requires human approval for this plan run (accepted approval doors: 'cli', 'mcp'), and none is recorded — ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI, or the 'mcp' door, then call finalize_plan again",
    )
    const other = await finalizeFor({ kernel: fakeKernel(notes, [], null, { source: 'agent' }, doors), config, p }).execute({}, 'call_2')
    expect((other.output as { error: string }).error).toBe(
      "an approval for this plan run WAS recorded, but it arrived through the 'agent' door, which is not among this project's accepted approval doors ('cli', 'mcp') — do not retry: ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI, or the 'mcp' door",
    )
  })

  // The gate is 'no plan note written since approval', not a content-hash match across builds.
  it('finalizes an untouched graph even when the approved hash is from another build', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    // 'f'*64 is a hash this build cannot reproduce, paired with an empty changed-set
    const result = await finalizeFor({ kernel: fakeKernel(notes, calls, 'f'.repeat(64)), config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('checks approval against the current run token, not another attempt', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const seen: string[] = []
    const base = fakeKernel(notes)
    const kernel = {
      ...base,
      approvedPlanHash: async (_taskId: string, runToken: string) => {
        seen.push(runToken)
        return runToken.endsWith(':a2') ? { hash: planGraphHash(notes), seq: 1 } : null
      },
    }
    const result = await finalizeFor({ kernel, config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(true)
    expect(seen).toEqual([p.runToken])
  })

  it('errors (never throws) when no masterplan note exists, naming the tool and not the task', async () => {
    const kernel = { approvalDoors: [GroundedApprovalDoor.cli], listPlanNotes: async () => [], approvedPlanHash: async () => null, nonHumanPlanApproval: async () => null, planNotesChangedSince: async () => [], proposeSplit: async () => { throw new Error('should not be called') } }
    const taskId = '7f1c2a9e-3b4d-4e5f-8a6b-9c0d1e2f3a4b'
    const r = await finalizeFor({ kernel, config, p: { ...p, taskId } }).execute({}, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('masterplan')
    expect(JSON.stringify(r.output)).toContain(PlanNoteToolName.write)
    expect(JSON.stringify(r.output)).not.toContain(taskId)
  })

  // A masterplan with no subplans: finalize_plan refuses actionably, never throws or splits.
  it('errors (never throws) when the masterplan lists no subplans', async () => {
    const notes = [note({ id: 'masterplan', title: 'M', subplans: [] })]
    const calls: unknown[] = []
    const r = await finalizeFor({ kernel: fakeKernel(notes, calls), config, p }).execute({}, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('subplans')
    expect(calls).toHaveLength(0)
  })

  // it force-auto-approves the derived split, so only the plan step is offered it
  it('a non-plan step gets no finalize_plan', () => {
    const kernel = fakeKernel([])
    expect(finalizePlanTool({ kernel, config, p: { ...p, role: STEP_ROLE.worker } })).toEqual([])
    expect(finalizePlanTool({ kernel, config, p: { ...p, stepId: STEP_ID.verify } })).toEqual([])
    expect(finalizePlanTool({ kernel, config, p }).map(t => t.name)).toEqual([PlanNoteToolName.finalize])
  })

  it("takes the split's title and spec from the masterplan, the spec led by its rationale on a Why: line", async () => {
    const notes = [
      note({ id: 'masterplan', title: 'Web app', body: 'the whole thing', rationale: 'users asked for it', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    await finalizeFor({ kernel: fakeKernel(notes, calls), config, p }).execute({}, 'call_1')
    expect(calls[0]).toMatchObject({ title: 'Web app', spec: 'Why: users asked for it\n\nthe whole thing' })
  })

  it('a post-approval edit names the notes that changed, not just that something did', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const kernel = {
      ...fakeKernel(notes),
      approvedPlanHash: async () => ({ hash: 'a'.repeat(64), seq: 41 }), // stale: the graph moved on
      planNotesChangedSince: async (_taskId: string, seq: number) => (seq === 41 ? ['a'] : []),
    }
    const r = await finalizeFor({ kernel, config, p }).execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('changed after approval')
    expect(JSON.stringify(r.output)).toContain("'a'")
  })

  it('surfaces a kernel rejection as isError, never a throw', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
      note({ id: 'a', title: 'A' }),
    ]
    const kernel = {
      approvalDoors: [GroundedApprovalDoor.cli],
      listPlanNotes: async () => notes,
      approvedPlanHash: async () => ({ hash: planGraphHash(notes), seq: 1 }),
      nonHumanPlanApproval: async () => null,
      planNotesChangedSince: async () => [],
      proposeSplit: async () => { throw new Error('split exceeds max depth 3') },
    }
    const tool = finalizeFor({ kernel, config, p })
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('depth')
  })
})

// autoCommit appends the commit step AFTER the finish step; off, only the finish step.
describe('autoCommit', () => {
  const notes = () => [
    note({ id: 'masterplan', title: 'M', subplans: ['a'] }),
    note({ id: 'a', title: 'A' }),
  ]

  it('on: the frozen split carries the trailing committer step', async () => {
    const calls: unknown[] = []
    const r = await finalizeFor({ kernel: fakeKernel(notes(), calls), config: { ...config, autoCommit: true }, p }).execute({}, 'call_1')
    expect(r.isError).toBe(false)
    const plan = (calls[0] as { plan: { steps: { id: string; role: string }[] } }).plan
    expect(plan.steps.map(s => s.id)).toEqual(['a', FINISH_STEP_ID, COMMIT_STEP_ID])
    expect(must(plan.steps.at(-1), 'last step').role).toBe(STEP_ROLE.committer)
  })

  it('off (default): the frozen plan is the bare decomposition plus the finish step, and nothing else', async () => {
    const calls: unknown[] = []
    await finalizeFor({ kernel: fakeKernel(notes(), calls), config, p }).execute({}, 'call_1')
    const plan = (calls[0] as { plan: unknown }).plan
    expect(plan).toEqual(withFinishStep(instantiateFrozenPlan('masterplan', notes()), { checks: [] }))
  })
})
