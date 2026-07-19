import { describe, expect, it } from 'bun:test'
import { LINK_KIND, type MemoryLink, type MemoryNote } from '@orc/contracts'
import { instantiateFrozenPlan, planScope } from './grounded-plan'

const note = (over: Partial<MemoryNote> & { id: string }): MemoryNote => ({
  scope: 'plan-t', kind: 'plan', sourceRevision: null, title: over.id, categories: [], tags: [],
  links: [], paths: [], rules: [], summary: '', body: '', rationale: '', uncertainty: [],
  createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1, ...over,
})
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

describe('instantiateFrozenPlan (pure, deterministic)', () => {
  it('translates decomposes_into children into steps and depends_on into dependsOn', () => {
    const notes: MemoryNote[] = [
      note({ id: 'masterplan', links: [link('db', LINK_KIND.decomposes_into), link('api', LINK_KIND.decomposes_into)] }),
      note({ id: 'db', title: 'DB', body: 'create the schema' }),
      note({ id: 'api', title: 'API', body: 'build the api', links: [link('db', LINK_KIND.depends_on)] }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'api'])
    expect(draft.steps.find(s => s.id === 'api')!.dependsOn).toEqual(['db'])
    expect(draft.steps.find(s => s.id === 'db')!.dependsOn).toEqual([])
    expect(draft.steps[0]).toEqual({ id: 'db', role: 'implementer', title: 'DB', instructions: 'create the schema', dependsOn: [], skillRefs: [], toolRefs: [] })
  })

  it('is a pure function of the notes: same input → identical output', () => {
    const notes: MemoryNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', summary: 'sum' }),
    ]
    expect(instantiateFrozenPlan('masterplan', notes)).toEqual(instantiateFrozenPlan('masterplan', notes))
    // instructions fall back title→summary→body: empty body uses summary
    expect(instantiateFrozenPlan('masterplan', notes).steps[0]!.instructions).toBe('sum')
  })

  it('drops depends_on edges to non-siblings (only sibling subplans become dependsOn)', () => {
    const notes: MemoryNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', links: [link('outsider', LINK_KIND.depends_on)] }),
    ]
    expect(instantiateFrozenPlan('masterplan', notes).steps[0]!.dependsOn).toEqual([])
  })

  it('planScope derives the per-task plan-note scope', () => {
    expect(planScope('abc-123')).toBe('plan-abc-123')
  })
})
