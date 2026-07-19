import { describe, expect, it } from 'bun:test'
import type { MemoryLink, MemoryNote, MemoryStore, NoteSummary } from '@orc/contracts'
import { finalizePlanTool } from './finalize-plan-tool'

const p = { taskId: 't1', stepId: 'plan', runToken: 'step:t1:plan:a1', executor: 'api-loop', modelRef: 'anthropic/x', maxIterations: 30 }
const config = { maxDepth: 3 }

const note = (over: Partial<MemoryNote> & { id: string }): MemoryNote => ({
  scope: 'plan-t1', kind: 'plan', sourceRevision: null, title: over.id, categories: [], tags: [],
  links: [], paths: [], rules: [], summary: '', body: '', rationale: '', uncertainty: [],
  createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1, ...over,
})
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

// minimal MemoryStore double: only list/get are exercised, scoped like the real store.
function fakeStore(notes: MemoryNote[]): MemoryStore {
  const inScope = (scope?: string) => notes.filter(n => scope === undefined || n.scope === scope)
  const fail = async (): Promise<never> => { throw new Error('unused in finalize_plan') }
  return {
    write: fail, remove: fail, search: fail, neighbors: fail,
    list: async filter => inScope(filter?.scope).map((n): NoteSummary => ({ id: n.id, scope: n.scope, title: n.title, categories: n.categories, tags: n.tags, summary: n.summary })),
    get: async (id, scope) => inScope(scope).find(n => n.id === id) ?? null,
  }
}

describe('finalize_plan tool', () => {
  it('freezes the plan-note graph into an auto-approved split (task_split path)', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'Web app', body: 'the whole thing', links: [link('db', 'decomposes_into'), link('api', 'decomposes_into')] }),
      note({ id: 'db', title: 'DB', body: 'schema' }),
      note({ id: 'api', title: 'API', body: 'endpoints', links: [link('db', 'depends_on')] }),
    ]
    const calls: unknown[] = []
    const kernel = { proposeSplit: async (input: unknown) => { calls.push(input); return { splitId: 'sp', childTaskId: 'c', gated: false } } }
    const tool = finalizePlanTool({ store: fakeStore(notes), kernel, config, p })
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
    const kernel = { proposeSplit: async () => { throw new Error('should not be called') } }
    const tool = finalizePlanTool({ store: fakeStore([]), kernel, config, p })
    const r = await tool.execute({}, 'call_x')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('masterplan')
  })

  it('scopes the read to plan-<taskId>: a different task’s notes never leak in', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'Mine', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
      note({ id: 'masterplan', scope: 'plan-other', title: 'Theirs', links: [link('x', 'decomposes_into')] }),
      note({ id: 'x', scope: 'plan-other', title: 'X' }),
    ]
    const calls: unknown[] = []
    const kernel = { proposeSplit: async (input: unknown) => { calls.push(input); return { splitId: 'sp', childTaskId: 'c', gated: false } } }
    const tool = finalizePlanTool({ store: fakeStore(notes), kernel, config, p })
    await tool.execute({}, 'call_1')
    expect(calls[0]).toMatchObject({ title: 'Mine', plan: { steps: [{ id: 'a' }] } })
  })

  it('surfaces a kernel rejection as isError, never a throw', async () => {
    const notes = [
      note({ id: 'masterplan', title: 'M', links: [link('a', 'decomposes_into')] }),
      note({ id: 'a', title: 'A' }),
    ]
    const kernel = { proposeSplit: async () => { throw new Error('split exceeds max depth 3') } }
    const tool = finalizePlanTool({ store: fakeStore(notes), kernel, config, p })
    const r = await tool.execute({}, 'call_1')
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('depth')
  })
})
