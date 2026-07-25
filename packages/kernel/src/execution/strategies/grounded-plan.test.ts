import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, LINK_KIND, type EventRecord, type MemoryLink, type PlanNote } from '@orc/contracts'
import { planNoteFixture, stepFixture } from '@orc/contracts/fixtures'
import { AUDITOR_CONTRACT, foldPlanNotes, groundedPlanOmission, instantiateFrozenPlan, planScope } from './grounded-plan'
import * as groundedPlan from './grounded-plan'

const note = (over: Partial<PlanNote> & { id: string }): PlanNote =>
  planNoteFixture({ scope: 'plan-t', title: over.id, ...over })
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

describe('planGraphHash', () => {
  it('is canonical across note order and changes with reviewed graph content/order', () => {
    expect(typeof groundedPlan.planGraphHash).toBe('function')
    const hash = groundedPlan.planGraphHash
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
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('db', LINK_KIND.decomposes_into), link('api', LINK_KIND.decomposes_into)] }),
      note({ id: 'db', title: 'DB', body: 'create the schema' }),
      note({ id: 'api', title: 'API', body: 'build the api', links: [link('db', LINK_KIND.depends_on)] }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'api'])
    expect(draft.steps.find(s => s.id === 'api')!.dependsOn).toEqual(['db'])
    expect(draft.steps.find(s => s.id === 'db')!.dependsOn).toEqual([])
    expect(draft.steps[0]).toEqual({ id: 'db', role: 'implementer', title: 'DB', instructions: 'create the schema', dependsOn: [], skillRefs: [], toolRefs: [], zone: [] })
  })

  it("freezes a note's declared write zone into the step — the fence, not the skill, holds it", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', body: 'x', zone: ['docs/**'] }),
      note({ id: 'b', title: 'B', body: 'y' }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.find(s => s.id === 'a')!.zone).toEqual(['docs/**'])
    expect(draft.steps.find(s => s.id === 'b')!.zone).toEqual([]) // undeclared = unfenced
  })

  it("freezes a 'verify' subplan as auditor; siblings stay implementer", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('work', LINK_KIND.decomposes_into), link('verify', LINK_KIND.decomposes_into)] }),
      note({ id: 'work', title: 'Work', body: 'do it' }),
      note({ id: 'verify', title: 'Verify', body: 'audit it', links: [link('work', LINK_KIND.depends_on)] }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.find(s => s.id === 'verify')!.role).toBe('auditor')
    expect(draft.steps.find(s => s.id === 'work')!.role).toBe('implementer')
    // the auditor contract is frozen into the verify step's instructions — plan-approved, not
    // injected as executor policy; implementer siblings never carry it
    expect(draft.steps.find(s => s.id === 'verify')!.instructions).toBe(`audit it\n\n${AUDITOR_CONTRACT}`)
    expect(draft.steps.find(s => s.id === 'work')!.instructions).toBe('do it')
  })

  it('is a pure function of the notes: same input → identical output', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', summary: 'sum' }),
    ]
    expect(instantiateFrozenPlan('masterplan', notes)).toEqual(instantiateFrozenPlan('masterplan', notes))
    // instructions fall back title→summary→body: empty body uses summary
    expect(instantiateFrozenPlan('masterplan', notes).steps[0]!.instructions).toBe('sum')
  })

  it('drops depends_on edges to non-siblings (only sibling subplans become dependsOn)', () => {
    const notes: PlanNote[] = [
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

  // a subplan's step gets only what its note declares — before this, toolRefs/skillRefs were
  // hardcoded empty, so a grounded plan could decompose work but never grant the capability to do
  // it: a research subplan reached execution with no way to search.
  it('freezes the capabilities a subplan declares into its step', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('research', LINK_KIND.decomposes_into), link('local', LINK_KIND.decomposes_into)] }),
      note({ id: 'research', toolRefs: ['web/search', 'web/fetch'], skillRefs: ['web-research'] }),
      note({ id: 'local' }),
    ]
    const steps = instantiateFrozenPlan('masterplan', notes).steps
    const research = steps.find(s => s.id === 'research')
    expect(research?.toolRefs).toEqual(['web/search', 'web/fetch'])
    expect(research?.skillRefs).toEqual(['web-research'])
    // a step that declares nothing gets nothing — capability is opt-in per subplan
    expect(steps.find(s => s.id === 'local')?.toolRefs).toEqual([])
    expect(steps.find(s => s.id === 'local')?.skillRefs).toEqual([])
  })

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
      written({ id: 'masterplan', scope, tier: 'plan', title: 'Web app', body: 'whole thing', links: [{ id: 'db', kind: 'decomposes_into' }, { id: 'api', kind: 'decomposes_into' }] }),
      written({ id: 'db', scope, tier: 'plan', title: 'DB', body: 'schema' }),
      written({ id: 'api', scope, tier: 'plan', title: 'API', body: 'endpoints', links: [{ id: 'db', kind: 'depends_on' }] }),
    ], scope)
    expect(notes.map(n => n.id).sort()).toEqual(['api', 'db', 'masterplan'])
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'api'])
    expect(draft.steps.find(s => s.id === 'api')!.dependsOn).toEqual(['db'])
  })

  it('keeps only the latest write per id and mirrors the projector\'s provenance (createdAt fixed, revision advances)', () => {
    const scope = planScope('t1')
    const v1 = written({ id: 'db', scope, tier: 'plan', title: 'DB v1', body: 'draft' })
    const v2 = written({ id: 'db', scope, tier: 'plan', title: 'DB v2', body: 'tightened' })
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
      written({ id: 'masterplan', scope, tier: 'plan', title: 'M' }),
      written({ id: 'gone', scope, tier: 'plan', title: 'Gone' }),
      deleted('gone', scope),
    ], scope)
    expect(notes.map(n => n.id)).toEqual(['masterplan'])
  })

  it('filters to the task\'s plan scope: another task\'s notes never leak in', () => {
    const notes = foldPlanNotes([
      written({ id: 'masterplan', scope: planScope('t1'), tier: 'plan', title: 'Mine' }),
      written({ id: 'masterplan', scope: planScope('t2'), tier: 'plan', title: 'Theirs' }),
      written({ id: 'analysis', scope: 'project', kind: 'fact', title: 'Arch' }),
    ], planScope('t1'))
    expect(notes.map(n => n.title)).toEqual(['Mine'])
  })

  it('stamps provenance from the event, not from the writer', () => {
    // regression: foldPlanNotes skipped the shared derivation and threw MemoryNote.parse on notes
    // whose provenance it had not stamped, wedging human approval (planGraphHash) and finalize.
    const scope = planScope('t1')
    const ev = written({ id: 'masterplan', scope, tier: 'plan', title: 'M' })
    const notes = foldPlanNotes([ev], scope)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.createdAt).toBe(ev.ts) // stamped from the canonical event ts
    expect(notes[0]!.revision).toBe(1)
  })

  // A task's plan scope also holds the episodic notes its own planning step left behind. Folding
  // those in would let a step note the human never reviewed move the plan hash after approval.
  it("folds ONLY the plan tier — the planning step's own ambient notes are not the plan", () => {
    const scope = planScope('t1')
    const notes = foldPlanNotes([
      written({ id: 'masterplan', scope, tier: 'plan', title: 'M' }),
      written({ id: 'step-author-plan', scope, tier: 'episodic', title: 'Authored the plan' }),
    ], scope)
    expect(notes.map(n => n.id)).toEqual(['masterplan'])
  })

  it('is lenient: one unparseable memory_written (any scope) is skipped, not fatal to the whole fold', () => {
    const scope = planScope('t1')
    const poison: EventRecord = {
      seq: ++seq, projectId: 'p', idempotencyKey: null, taskId: null, stepId: null, runToken: null,
      kind: EVENT_KIND.memory_written, payload: { note: { id: 'BAD ID WITH SPACES' }, author: { source: 'agent' } },
      usage: null, ts: '2026-01-01T00:00:59.000Z',
    }
    const notes = foldPlanNotes([poison, written({ id: 'masterplan', scope, tier: 'plan', title: 'M' })], scope)
    expect(notes.map(n => n.id)).toEqual(['masterplan'])
  })
})

// The grounded strategy exists to DECOMPOSE. A plan step that signals success without freezing a
// split did not do its job — and the run reported success anyway, with an empty plan graph. This
// happened on a real run: the agent verified the analyze step's work itself and passed.
describe('groundedPlanOmission', () => {
  const runToken = 'step:t1:plan:a1'
  const grounded = (over: Partial<EventRecord> = {}): EventRecord => ({
    seq: 1, projectId: 'p', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null,
    kind: EVENT_KIND.plan_proposed, usage: null, ts: '2026-07-24T00:00:00.000Z',
    payload: { plan: { taskId: 't1', version: 1, strategyRef: 'grounded-plan', costEstimateUSD: null, steps: [stepFixture({ id: 'plan' })] } },
    ...over,
  })
  const split = (token: string): EventRecord => grounded({
    seq: 2, kind: EVENT_KIND.split_proposed,
    payload: { splitId: 's1', taskId: 't1', stepId: 'plan', runToken: token, childTaskId: 'c1' },
  })

  it('refuses a plan step that signalled success without freezing a split', () => {
    const reason = groundedPlanOmission([grounded()], 'plan', runToken)
    expect(reason).toContain('finalize_plan')
    expect(reason).toContain('masterplan')
  })

  it('accepts a plan step that proposed its split', () => {
    expect(groundedPlanOmission([grounded(), split(runToken)], 'plan', runToken)).toBeNull()
  })

  // a split from an EARLIER attempt is not this attempt's work — the check is per runToken
  it('does not accept another attempt\'s split', () => {
    expect(groundedPlanOmission([grounded(), split('step:t1:plan:a0')], 'plan', runToken)).toContain('finalize_plan')
  })

  it('leaves every other step alone — only the grounded plan step owes a plan', () => {
    expect(groundedPlanOmission([grounded()], 'verify', runToken)).toBeNull()
    // same step id, but the task is not a grounded-plan task
    const authored = grounded({ payload: { plan: { taskId: 't1', version: 1, strategyRef: 'single-step', costEstimateUSD: null, steps: [stepFixture({ id: 'plan' })] } } })
    expect(groundedPlanOmission([authored], 'plan', runToken)).toBeNull()
  })
})
