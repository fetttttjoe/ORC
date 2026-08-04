import { describe, expect, it } from 'bun:test'
import { GROUNDED_APPROVAL_DOOR, type MemoryLink, type PlanNote } from '@orc/contracts'
import { planNoteFixture } from '@orc/contracts/fixtures'
import { finalizePlanTool } from './finalize-plan-tool'
import { instantiateFrozenPlan, planGraphHash } from './strategies/grounded-plan'

const p = { taskId: 't1', stepId: 'plan', runToken: 'step:t1:plan:a1', role: 'auditor', executor: 'api-loop', modelRef: 'anthropic/x', maxIterations: 30 }
const config = { maxDepth: 3 }

const note = (over: Partial<PlanNote> & { id: string }): PlanNote =>
  planNoteFixture({ scope: 'plan-t1', title: over.id, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', ...over })
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

// FixE: finalize_plan now sources the frozen plan from kernel.listPlanNotes (a LOG fold) — never the
// SurrealDB projection. The double models that log-fold; there is NO memory store here, so a finalize
// that still read the async read model could not possibly work.
function fakeKernel(
  notes: PlanNote[], calls: unknown[] = [], approvedHash: string | null = planGraphHash(notes),
  nonHuman: { source: string } | null = null,
  doors: readonly string[] = [GROUNDED_APPROVAL_DOOR.cli],
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
      note({ id: 'masterplan', title: 'Web app', body: 'the whole thing', links: [link('db', 'decomposes_into'), link('api', 'decomposes_into')] }),
      note({ id: 'db', title: 'DB', body: 'schema' }),
      note({ id: 'api', title: 'API', body: 'endpoints', dependsOn: ['db'] }),
    ]
    const calls: unknown[] = []
    const tool = finalizePlanTool({ kernel: fakeKernel(notes, calls), config, p })
    expect(tool.name).toBe('finalize_plan')
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(false)
    expect(r.output).toEqual({ splitId: 'sp', childTaskId: 'c', gated: false })
    expect(calls[0]).toMatchObject({
      parentTaskId: 't1', stepId: 'plan', runToken: 'step:t1:plan:a1', toolCallId: 'call_1', title: 'Web app',
      policy: { default: 'auto' }, maxDepth: 3,
      parentStep: { executorRef: 'api-loop', modelRef: 'anthropic/x', maxIterations: 30 },
      plan: { steps: [{ id: 'db', role: 'implementer', dependsOn: [] }, { id: 'api', dependsOn: ['db'] }] },
    })
  })

  it('rejects finalize when no matching human approval exists', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const result = await finalizePlanTool({ kernel: fakeKernel(notes, calls, null), config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.output)).toContain('approval')
    expect(calls).toHaveLength(0)
  })

  // A refusal that only says "no" costs a round-trip: the plan agent cannot type an `orc reply`
  // itself, so the message has to name the doors a HUMAN can use, verbatim enough to relay.
  it('no approval at all names the concrete human doors (orc reply + the web UI)', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const r = await finalizePlanTool({ kernel: fakeKernel(notes, calls, null), config, p }).execute({}, 'call_1')
    expect(r.isError).toBe(true)
    // exact text: the message names the ACCEPTED door set (default 'cli') and the human doors that
    // set implies. `orc reply <taskId> approve` is verbatim, placeholder and all — the real taskId
    // must never reach a model prompt.
    expect((r.output as { error: string }).error).toBe(
      "finalize_plan requires human approval for this plan run (accepted approval doors: 'cli'), and none is recorded — ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI, then call finalize_plan again",
    )
    expect(calls).toHaveLength(0)
  })

  // The observed defect: an 'approve' typed through the MCP door IS recorded (with a planHash),
  // but approvedPlanHash discards it — so the agent saw the same "needs approval" it saw when
  // nobody had approved, and retried. Say what happened, and NAME the door it came through.
  it('an approval from a non-human door says so, names that source, and still points at the human doors', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const r = await finalizePlanTool({ kernel: fakeKernel(notes, calls, null, { source: 'mcp' }), config, p }).execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect((r.output as { error: string }).error).toBe(
      "an approval for this plan run WAS recorded, but it arrived through the 'mcp' door, which is not among this project's accepted approval doors ('cli') — do not retry: ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI",
    )
    expect(calls).toHaveLength(0)

    // the source is READ FROM THE EVENT, not a hardcoded 'mcp' in the message builder
    const agent = await finalizePlanTool({ kernel: fakeKernel(notes, calls, null, { source: 'agent' }), config, p }).execute({}, 'call_2')
    expect(agent.isError).toBe(true)
    expect(JSON.stringify(agent.output)).toContain('agent')
    expect(JSON.stringify(agent.output)).not.toContain('mcp')
    expect(calls).toHaveLength(0)
  })

  // The refusal quotes the kernel's CONFIGURED door set, not a literal: an operator who opened the
  // mcp door must not be told by the refusal to go type in a terminal for a gate that no longer
  // requires it. Same list the gate tests, so advice and gate cannot disagree.
  it('the refusal names the operator-configured door set, not a hardcoded one', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const doors = [GROUNDED_APPROVAL_DOOR.cli, GROUNDED_APPROVAL_DOOR.mcp]
    const none = await finalizePlanTool({ kernel: fakeKernel(notes, [], null, null, doors), config, p }).execute({}, 'call_1')
    expect((none.output as { error: string }).error).toBe(
      "finalize_plan requires human approval for this plan run (accepted approval doors: 'cli', 'mcp'), and none is recorded — ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI, or the 'mcp' door, then call finalize_plan again",
    )
    const other = await finalizePlanTool({ kernel: fakeKernel(notes, [], null, { source: 'agent' }, doors), config, p }).execute({}, 'call_2')
    expect((other.output as { error: string }).error).toBe(
      "an approval for this plan run WAS recorded, but it arrived through the 'agent' door, which is not among this project's accepted approval doors ('cli', 'mcp') — do not retry: ask the human to approve via `orc reply <taskId> approve` in a terminal, or in the web UI, or the 'mcp' door",
    )
  })

  // The gate is "nothing was written to the plan scope since the human approved" — NOT "two builds
  // agree on a content hash". Observed live on task b3a49133 (project orc-sim): the human approved
  // in the graph UI, whose server process had been running since before `dependsOn` was added to
  // PlanNoteInput, so its MemoryNote.parse silently dropped that field and it stamped a hash the
  // executor — running a newer build — could not reproduce for the very same notes. The human
  // approved the identical, untouched plan eight times and every finalize_plan was rejected, while
  // planNotesChangedSince correctly reported that nothing had changed, so the error could not even
  // name a cause. An approval nothing has edited since MUST finalize, whoever computed the hash.
  it('finalizes an untouched graph even when the approved hash is from another build', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    // 'f'*64 is a hash this build cannot reproduce, paired with an empty changed-set: exactly the
    // state a second, older process leaves behind — and unreachable any other way, because
    // foldPlanNotes is a pure function of exactly the events planNotesChangedSince counts.
    const result = await finalizePlanTool({ kernel: fakeKernel(notes, calls, 'f'.repeat(64)), config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('checks approval against the current run token, not another attempt', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
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
    const result = await finalizePlanTool({ kernel, config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(true)
    expect(seen).toEqual([p.runToken])
  })

  it('errors (never throws) when no masterplan note exists in scope', async () => {
    const kernel = { approvalDoors: [GROUNDED_APPROVAL_DOOR.cli], listPlanNotes: async () => [], approvedPlanHash: async () => null, nonHumanPlanApproval: async () => null, planNotesChangedSince: async () => [], proposeSplit: async () => { throw new Error('should not be called') } }
    const tool = finalizePlanTool({ kernel, config, p })
    const r = await tool.execute({}, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('masterplan')
  })

  // The silent-failure bug (incidents c4bc1d38, 8b5e1034): a masterplan note EXISTS but its
  // decomposes_into links were dropped during a warning fix-up, so the freeze yields steps: [] and
  // (with autoCommit) a commit-only pipeline that reports done having written no code. finalize_plan
  // must refuse it as an actionable error, never throw, and never propose a split.
  it('errors (never throws) when the masterplan note has zero decomposes_into links', async () => {
    const notes = [note({ id: 'masterplan', title: 'M', links: [] })]
    const calls: unknown[] = []
    const tool = finalizePlanTool({ kernel: fakeKernel(notes, calls), config, p })
    const r = await tool.execute({}, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('decomposes_into')
    expect(calls).toHaveLength(0)
  })

  // M3 defense-in-depth: finalize_plan force-auto-approves the derived split, so it is gated to the
  // grounded plan-authoring (auditor) step. A future change exposing taskId in a prompt must not let
  // any other step call it and bypass the approval policy.
  it('refuses to run for a non-auditor step (isError, no split)', async () => {
    const notes = [note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }), note({ id: 'a', title: 'A' })]
    const calls: unknown[] = []
    const tool = finalizePlanTool({ kernel: fakeKernel(notes, calls), config, p: { ...p, role: 'worker' } })
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('auditor')
    expect(calls).toHaveLength(0)
  })

  it('a post-approval edit names the notes that changed, not just that something did', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const kernel = {
      ...fakeKernel(notes),
      approvedPlanHash: async () => ({ hash: 'a'.repeat(64), seq: 41 }), // stale: the graph moved on
      planNotesChangedSince: async (_taskId: string, seq: number) => (seq === 41 ? ['a'] : []),
    }
    const r = await finalizePlanTool({ kernel, config, p }).execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('changed after approval')
    expect(JSON.stringify(r.output)).toContain("'a'")
  })

  it('surfaces a kernel rejection as isError, never a throw', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const kernel = {
      approvalDoors: [GROUNDED_APPROVAL_DOOR.cli],
      listPlanNotes: async () => notes,
      approvedPlanHash: async () => ({ hash: planGraphHash(notes), seq: 1 }),
      nonHumanPlanApproval: async () => null,
      planNotesChangedSince: async () => [],
      proposeSplit: async () => { throw new Error('split exceeds max depth 3') },
    }
    const tool = finalizePlanTool({ kernel, config, p })
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('depth')
  })
})

// autoCommit appends the kernel-owned commit step at the freeze — the truthful-stamp pipeline's
// tail. Off (the default) freezes byte-for-byte as before.
describe('autoCommit', () => {
  const notes = () => [
    note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
    note({ id: 'a', title: 'A' }),
  ]

  it('on: the frozen split carries the trailing committer step', async () => {
    const calls: unknown[] = []
    const r = await finalizePlanTool({ kernel: fakeKernel(notes(), calls), config: { ...config, autoCommit: true }, p }).execute({}, 'call_1')
    expect(r.isError).toBe(false)
    const plan = (calls[0] as { plan: { steps: { id: string; role: string }[] } }).plan
    expect(plan.steps.map(s => s.id)).toEqual(['a', 'commit'])
    expect(plan.steps.at(-1)!.role).toBe('committer')
  })

  it('off (default): the frozen plan is byte-identical to the bare decomposition', async () => {
    const calls: unknown[] = []
    await finalizePlanTool({ kernel: fakeKernel(notes(), calls), config, p }).execute({}, 'call_1')
    const plan = (calls[0] as { plan: unknown }).plan
    expect(plan).toEqual(instantiateFrozenPlan('masterplan', notes()))
  })
})
