import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, LINK_KIND, type EventRecord, type MemoryLink, type MemoryNote } from '@orc/contracts'
import { foldPlanNotes, instantiateFrozenPlan, planScope } from './grounded-plan'
import * as groundedPlan from './grounded-plan'

const note = (over: Partial<MemoryNote> & { id: string }): MemoryNote => ({
  scope: 'plan-t', kind: 'plan', sourceRevision: null, title: over.id, categories: [], tags: [],
  links: [], paths: [], rules: [], summary: '', body: '', sources: [], rationale: '', uncertainty: [],
  createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1, ...over,
})
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

describe('planGraphHash', () => {
  it('is canonical across note order and changes with reviewed graph content/order', () => {
    expect(typeof groundedPlan.planGraphHash).toBe('function')
    const hash = (groundedPlan as typeof groundedPlan & { planGraphHash(notes: MemoryNote[]): string }).planGraphHash
    const notes = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', body: 'A', uncertainty: ['verify A'] }),
      note({ id: 'b', body: 'B' }),
    ]
    const original = hash(notes)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
    expect(hash([...notes].reverse())).toBe(original)
    expect(hash(notes.map(n => n.id === 'a' ? { ...n, body: 'changed' } : n))).not.toBe(original)
    expect(hash(notes.map(n => n.id === 'masterplan' ? { ...n, links: [...n.links].reverse() } : n))).not.toBe(original)
    expect(hash(notes.map(n => n.id === 'a' ? { ...n, uncertainty: ['different'] } : n))).not.toBe(original)
  })
})

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

// FixE: the freeze is built from the EVENT LOG, not the async SurrealDB projection. foldPlanNotes
// reconstructs the plan-note graph from memory_written/memory_deleted events — synchronously durable
// at finalize time — so a lagging read model can never yield "no masterplan".
describe('foldPlanNotes (log-fold, projection-independent)', () => {
  let seq = 0
  const written = (note: Record<string, unknown>): EventRecord => ({
    seq: ++seq, projectId: 'p', idempotencyKey: null, taskId: null, stepId: null, runToken: null,
    kind: EVENT_KIND.memory_written, payload: { note, author: { source: 'agent' } }, usage: null,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  })
  const deleted = (id: string, scope: string): EventRecord => ({
    seq: ++seq, projectId: 'p', idempotencyKey: null, taskId: null, stepId: null, runToken: null,
    kind: EVENT_KIND.memory_deleted, payload: { id, scope, author: { source: 'cli' } }, usage: null,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  })

  it('reconstructs the plan-note graph so instantiateFrozenPlan yields the approved draft', () => {
    const scope = planScope('t1')
    const notes = foldPlanNotes([
      written({ id: 'masterplan', scope, kind: 'plan', title: 'Web app', body: 'whole thing', links: [{ id: 'db', kind: 'decomposes_into' }, { id: 'api', kind: 'decomposes_into' }] }),
      written({ id: 'db', scope, kind: 'plan', title: 'DB', body: 'schema' }),
      written({ id: 'api', scope, kind: 'plan', title: 'API', body: 'endpoints', links: [{ id: 'db', kind: 'depends_on' }] }),
    ], scope)
    expect(notes.map(n => n.id).sort()).toEqual(['api', 'db', 'masterplan'])
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'api'])
    expect(draft.steps.find(s => s.id === 'api')!.dependsOn).toEqual(['db'])
  })

  it('keeps only the latest write per id and mirrors the projector\'s provenance (createdAt fixed, revision advances)', () => {
    const scope = planScope('t1')
    const v1 = written({ id: 'db', scope, kind: 'plan', title: 'DB v1', body: 'draft' })
    const v2 = written({ id: 'db', scope, kind: 'plan', title: 'DB v2', body: 'tightened' })
    const notes = foldPlanNotes([v1, v2], scope)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.title).toBe('DB v2')
    expect(notes[0]!.revision).toBe(2)
    expect(notes[0]!.createdAt).toBe(v1.ts) // fixed to the first write
    expect(notes[0]!.updatedAt).toBe(v2.ts) // advances to the latest write
  })

  it('drops ids removed by a later memory_deleted', () => {
    const scope = planScope('t1')
    const notes = foldPlanNotes([
      written({ id: 'masterplan', scope, kind: 'plan', title: 'M' }),
      written({ id: 'gone', scope, kind: 'plan', title: 'Gone' }),
      deleted('gone', scope),
    ], scope)
    expect(notes.map(n => n.id)).toEqual(['masterplan'])
  })

  it('filters to the task\'s plan scope: another task\'s notes never leak in', () => {
    const notes = foldPlanNotes([
      written({ id: 'masterplan', scope: planScope('t1'), kind: 'plan', title: 'Mine' }),
      written({ id: 'masterplan', scope: planScope('t2'), kind: 'plan', title: 'Theirs' }),
      written({ id: 'analysis', scope: 'project', kind: 'fact', title: 'Arch' }),
    ], planScope('t1'))
    expect(notes.map(n => n.title)).toEqual(['Mine'])
  })
})
