import { describe, expect, it } from 'bun:test'
import { LINK_KIND, type MemoryLink, type MemoryNote } from '@orc/contracts'
import { finalizePlanTool } from './finalize-plan-tool'

const p = { taskId: 't1', stepId: 'plan', runToken: 'step:t1:plan:a1', role: 'auditor', executor: 'api-loop', modelRef: 'anthropic/x', maxIterations: 30 }
const config = { maxDepth: 3 }

const note = (over: Partial<MemoryNote> & { id: string }): MemoryNote => ({
  scope: 'plan-t1', kind: 'plan', sourceRevision: null, title: over.id, categories: [], tags: [],
  links: [], paths: [], rules: [], summary: '', body: '', rationale: '', uncertainty: [],
  createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1, ...over,
})
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

// FixE: finalize_plan now sources the frozen plan from kernel.listPlanNotes (a LOG fold) — never the
// SurrealDB projection. The double models that log-fold; there is NO memory store here, so a finalize
// that still read the async read model could not possibly work.
function fakeKernel(notes: MemoryNote[], calls: unknown[] = []): Pick<import('../kernel').Kernel, 'proposeSplit' | 'listPlanNotes'> {
  return {
    listPlanNotes: async () => notes,
    proposeSplit: async (input: unknown) => { calls.push(input); return { splitId: 'sp', childTaskId: 'c', gated: false } },
  }
}

describe('finalize_plan tool', () => {
  it('freezes the log-reconstructed plan-note graph into an auto-approved split (task_split path)', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'Web app', body: 'the whole thing', links: [link('db', 'decomposes_into'), link('api', 'decomposes_into')] }),
      note({ id: 'db', title: 'DB', body: 'schema' }),
      note({ id: 'api', title: 'API', body: 'endpoints', links: [link('db', 'depends_on')] }),
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

  it('errors (never throws) when no masterplan note exists in scope', async () => {
    const kernel = { listPlanNotes: async () => [], proposeSplit: async () => { throw new Error('should not be called') } }
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

  it('surfaces a kernel rejection as isError, never a throw', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const kernel = { listPlanNotes: async () => notes, proposeSplit: async () => { throw new Error('split exceeds max depth 3') } }
    const tool = finalizePlanTool({ kernel, config, p })
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('depth')
  })
})
