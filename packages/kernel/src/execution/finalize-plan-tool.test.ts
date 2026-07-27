import { describe, expect, it } from 'bun:test'
import type { MemoryLink, PlanNote } from '@orc/contracts'
import { planNoteFixture } from '@orc/contracts/fixtures'
import { finalizePlanTool } from './finalize-plan-tool'
import { planGraphHash } from './strategies/grounded-plan'

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
): Pick<import('../kernel').Kernel, 'proposeSplit' | 'listPlanNotes' | 'approvedPlanHash' | 'planNotesChangedSince'> {
  return {
    listPlanNotes: async () => notes,
    approvedPlanHash: async () => (approvedHash === null ? null : { hash: approvedHash, seq: 1 }),
    planNotesChangedSince: async () => [],
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

  it('rejects finalize when the graph changed after approval', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const calls: unknown[] = []
    const result = await finalizePlanTool({ kernel: fakeKernel(notes, calls, 'f'.repeat(64)), config, p }).execute({}, 'call_1')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.output)).toContain('changed after approval')
    expect(calls).toHaveLength(0)
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
    const kernel = { listPlanNotes: async () => [], approvedPlanHash: async () => null, planNotesChangedSince: async () => [], proposeSplit: async () => { throw new Error('should not be called') } }
    const tool = finalizePlanTool({ kernel, config, p })
    const r = await tool.execute({}, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('masterplan')
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
      listPlanNotes: async () => notes,
      approvedPlanHash: async () => ({ hash: planGraphHash(notes), seq: 1 }),
      planNotesChangedSince: async () => [],
      proposeSplit: async () => { throw new Error('split exceeds max depth 3') },
    }
    const tool = finalizePlanTool({ kernel, config, p })
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('depth')
  })
})
