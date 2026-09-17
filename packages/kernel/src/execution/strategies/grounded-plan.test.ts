import { describe, expect, it } from 'bun:test'
import { COMMIT_STEP_ID, EVENT_KIND, FINISH_STEP_ID, LINK_KIND, ROLE_SKILL, STEP_ROLE, type EventRecord, type MemoryLink, type PlanNote } from '@orc/contracts'
import { TEST_WORKSPACE_ID, eventFixture, must, planNoteFixture, stepFixture } from '@orc/contracts/fixtures'
import { foldPlanNotes, freezePlan, groundedPlanOmission, instantiateFrozenPlan, planGraphHash, planScope, withCommitStep } from './grounded-plan'
// the appender lives in the pure module now (finish-step.ts, contracts-only imports); this describe
// stays here because its subject is what the FREEZE ends with, not the appender in isolation
import { withFinishStep } from '../../finish-step'

const note = (over: Partial<PlanNote> & { id: string }): PlanNote =>
  planNoteFixture({ scope: 'plan-t', title: over.id, ...over })
const link = (id: string, kind: MemoryLink['kind']): MemoryLink => ({ id, kind })

describe('planGraphHash', () => {
  it('is canonical across note order and changes with reviewed graph content/order', () => {
    const hash = planGraphHash
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
  it('translates decomposes_into children into steps and the dependsOn field into ordering', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('db', LINK_KIND.decomposes_into), link('api', LINK_KIND.decomposes_into)] }),
      note({ id: 'db', title: 'DB', body: 'create the schema' }),
      note({ id: 'api', title: 'API', body: 'build the api', dependsOn: ['db'] }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'api'])
    expect(must(draft.steps.find(s => s.id === 'api'), 'draft.steps.find(s => s.id === \'api\')').dependsOn).toEqual(['db'])
    expect(must(draft.steps.find(s => s.id === 'db'), 'draft.steps.find(s => s.id === \'db\')').dependsOn).toEqual([])
    expect(draft.steps[0]).toEqual({ id: 'db', role: 'implementer', title: 'DB', instructions: 'create the schema', dependsOn: [], skillRefs: [], toolRefs: [], zone: [] })
  })

  it("freezes a note's declared write zone into the step — the fence, not the skill, holds it", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', body: 'x', zone: ['docs/**'] }),
      note({ id: 'b', title: 'B', body: 'y' }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(must(draft.steps.find(s => s.id === 'a'), 'draft.steps.find(s => s.id === \'a\')').zone).toEqual(['docs/**'])
    expect(must(draft.steps.find(s => s.id === 'b'), 'draft.steps.find(s => s.id === \'b\')').zone).toEqual([]) // undeclared = unfenced
  })

  it("freezes a 'verify' subplan as auditor; siblings stay implementer", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('work', LINK_KIND.decomposes_into), link('verify', LINK_KIND.decomposes_into)] }),
      note({ id: 'work', title: 'Work', body: 'do it' }),
      note({ id: 'verify', title: 'Verify', body: 'audit it', dependsOn: ['work'] }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(must(draft.steps.find(s => s.id === 'verify'), 'draft.steps.find(s => s.id === \'verify\')').role).toBe('auditor')
    expect(must(draft.steps.find(s => s.id === 'work'), 'draft.steps.find(s => s.id === \'work\')').role).toBe('implementer')
    // the auditor + heal contracts ride as the kernel-appended role skill — the REF is frozen
    // into the plan (planner can't remove it); implementer siblings never carry it
    expect(must(draft.steps.find(s => s.id === 'verify'), 'draft.steps.find(s => s.id === \'verify\')').instructions).toBe('audit it')
    expect(must(draft.steps.find(s => s.id === 'verify'), 'draft.steps.find(s => s.id === \'verify\')').skillRefs).toEqual([ROLE_SKILL.auditor])
    expect(must(draft.steps.find(s => s.id === 'work'), 'draft.steps.find(s => s.id === \'work\')').instructions).toBe('do it')
    expect(must(draft.steps.find(s => s.id === 'work'), 'draft.steps.find(s => s.id === \'work\')').skillRefs).toEqual([])
  })

  it('freezes a verify note that already names the role skill without duplication', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('work', LINK_KIND.decomposes_into), link('verify', LINK_KIND.decomposes_into)] }),
      note({ id: 'work', title: 'Work', body: 'do it' }),
      note({ id: 'verify', title: 'Verify', body: 'audit it', dependsOn: ['work'], skillRefs: [ROLE_SKILL.auditor] }),
    ]
    expect(must(instantiateFrozenPlan('masterplan', notes).steps.find(s => s.id === 'verify'), 'verify step').skillRefs).toEqual([ROLE_SKILL.auditor])
  })

  it('is a pure function of the notes: same input → identical output', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', summary: 'sum' }),
    ]
    expect(instantiateFrozenPlan('masterplan', notes)).toEqual(instantiateFrozenPlan('masterplan', notes))
    // instructions fall back title→summary→body: empty body uses summary
    expect(must(instantiateFrozenPlan('masterplan', notes).steps[0], 'instantiateFrozenPlan(\'masterplan\', notes).steps[0]').instructions).toBe('sum')
  })

  // A depends_on LINK to a NON-sibling is knowledge ("builds on that finding") and never schedules.
  it('drops depends_on edges to non-siblings (only sibling subplans become dependsOn)', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', links: [link('outsider', LINK_KIND.depends_on)] }),
    ]
    expect(must(instantiateFrozenPlan('masterplan', notes).steps[0], 'instantiateFrozenPlan(\'masterplan\', notes).steps[0]').dependsOn).toEqual([])
  })

  // A link to a SIBLING is a spelling error with an obvious correction: honouring it would keep two
  // ways to say one thing, and ignoring it would drop the ordering and let the step run early.
  it('rejects a depends_on link to a sibling and names the field to use instead', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A' }),
      note({ id: 'b', title: 'B', links: [link('a', LINK_KIND.depends_on)] }),
    ]
    expect(() => instantiateFrozenPlan('masterplan', notes)).toThrow(/dependsOn.*FIELD, not a link/s)
  })

  it('takes ordering from the dependsOn field', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A' }),
      note({ id: 'b', title: 'B', dependsOn: ['a'] }),
    ]
    expect(must(instantiateFrozenPlan('masterplan', notes).steps.find(s => s.id === 'b'), 'step b').dependsOn).toEqual(['a'])
  })

  // A missing dependency lets a step run EARLY — silent corruption. A surplus one only makes it run
  // later. So an unresolvable target widens to every sibling rather than being dropped or throwing:
  // the planner replaced `a` with a-read/a-write while `b` kept dependsOn ['a'].
  it('heals a stale ordering target by waiting on every sibling, never by dropping it', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a-read', LINK_KIND.decomposes_into), link('a-write', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a-read', title: 'A read' }),
      note({ id: 'a-write', title: 'A write' }),
      note({ id: 'b', title: 'B', dependsOn: ['a'] }), // 'a' no longer exists
    ]
    const b = must(instantiateFrozenPlan('masterplan', notes).steps.find(s => s.id === 'b'), 'step b')
    expect(b.dependsOn).toEqual(['a-read', 'a-write']) // never [], never containing itself
  })

  it('the heal stays deterministic and never self-depends', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into), link('b', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', dependsOn: ['gone'] }),
      note({ id: 'b', title: 'B' }),
    ]
    const first = instantiateFrozenPlan('masterplan', notes)
    expect(must(first.steps.find(s => s.id === 'a'), 'first.steps.find(s => s.id === \'a\')').dependsOn).toEqual(['b'])
    expect(first).toEqual(instantiateFrozenPlan('masterplan', notes))
  })

  // A masterplan with NO decomposes_into links freezes to steps: [] — and with autoCommit on,
  // withCommitStep then appends a trailing commit step, yielding a commit-only pipeline that reports
  // done having written no code. This is the silent-failure bug (incidents c4bc1d38, 8b5e1034): the
  // plan agent dropped the links rewriting the masterplan during warning fix-ups (memory_write
  // replaces links wholesale). Refuse at the freeze — the ONE derivation — naming the fix.
  it('refuses a masterplan with zero decomposes_into links, naming the fix', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', title: 'M', links: [] }),
    ]
    expect(() => instantiateFrozenPlan('masterplan', notes)).toThrow(/decomposes_into/)
  })

  it('refuses a masterplan whose only links are not decomposes_into (e.g. depends_on / relates_to)', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', title: 'M', links: [link('other', LINK_KIND.relates_to), link('again', LINK_KIND.depends_on)] }),
      note({ id: 'other', title: 'Other' }),
      note({ id: 'again', title: 'Again' }),
    ]
    expect(() => instantiateFrozenPlan('masterplan', notes)).toThrow(/decomposes_into/)
  })

  it('planScope derives the per-task plan-note scope', () => {
    expect(planScope('abc-123')).toBe('plan-abc-123')
  })

  // A reviewed uncertainty entry is load-bearing material the human approved along with the rest
  // of the plan note — dropping it silently at the freeze means the executing agent never sees it.
  it('appends reviewed uncertainty entries to the derived instructions', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', body: 'do the thing', uncertainty: ['unresolved: does X handle Y?', 'second gap: Z is unverified'] }),
    ]
    const instructions = must(instantiateFrozenPlan('masterplan', notes).steps[0], 'instantiateFrozenPlan(\'masterplan\', notes).steps[0]').instructions
    expect(instructions).toContain('unresolved: does X handle Y?')
    expect(instructions).toContain('second gap: Z is unverified')
  })

  // The default `uncertainty: []` must leave the derived instructions byte-identical to what
  // `n.body || n.summary || n.title` alone produces — no heading, nothing appended.
  it('leaves instructions byte-identical to body||summary||title when uncertainty is empty', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', links: [link('a', LINK_KIND.decomposes_into)] }),
      note({ id: 'a', title: 'A', body: 'do the thing' }),
    ]
    const n = must(notes.find(x => x.id === 'a'), 'notes.find(x => x.id === \'a\')')
    const instructions = must(instantiateFrozenPlan('masterplan', notes).steps[0], 'instantiateFrozenPlan(\'masterplan\', notes).steps[0]').instructions
    expect(instructions).toBe(n.body || n.summary || n.title)
    expect(instructions).toBe('do the thing')
  })
})

// the freeze is built from the EVENT LOG, not the async SurrealDB projection. foldPlanNotes
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
  const written = (note: Record<string, unknown>): EventRecord => eventFixture({
    seq: ++seq, projectId: 'p', taskId: null, kind: EVENT_KIND.memory_written,
    payload: { note, author: { source: 'agent', workspaceId: TEST_WORKSPACE_ID } },
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  })
  const deleted = (id: string, scope: string): EventRecord => eventFixture({
    seq: ++seq, projectId: 'p', taskId: null, kind: EVENT_KIND.memory_deleted,
    payload: { id, scope, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } },
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  })

  it('reconstructs the plan-note graph so instantiateFrozenPlan yields the approved draft', () => {
    const scope = planScope('t1')
    const notes = foldPlanNotes([
      written({ id: 'masterplan', scope, tier: 'plan', title: 'Web app', body: 'whole thing', links: [{ id: 'db', kind: LINK_KIND.decomposes_into }, { id: 'api', kind: LINK_KIND.decomposes_into }] }),
      written({ id: 'db', scope, tier: 'plan', title: 'DB', body: 'schema' }),
      written({ id: 'api', scope, tier: 'plan', title: 'API', body: 'endpoints', dependsOn: ['db'] }),
    ], scope)
    expect(notes.map(n => n.id).sort()).toEqual(['api', 'db', 'masterplan'])
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'api'])
    expect(must(draft.steps.find(s => s.id === 'api'), 'draft.steps.find(s => s.id === \'api\')').dependsOn).toEqual(['db'])
  })

  it('keeps only the latest write per id and mirrors the projector\'s provenance (createdAt fixed, revision advances)', () => {
    const scope = planScope('t1')
    const v1 = written({ id: 'db', scope, tier: 'plan', title: 'DB v1', body: 'draft' })
    const v2 = written({ id: 'db', scope, tier: 'plan', title: 'DB v2', body: 'tightened' })
    const notes = foldPlanNotes([v1, v2], scope)
    expect(notes).toHaveLength(1)
    expect(must(notes[0], 'notes[0]').title).toBe('DB v2')
    expect(must(notes[0], 'notes[0]').revision).toBe(2)
    expect(must(notes[0], 'notes[0]').createdAt).toBe(v1.ts) // fixed to the first write
    expect(must(notes[0], 'notes[0]').updatedAt).toBe(v2.ts) // advances to the latest write
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
    expect(must(notes[0], 'notes[0]').createdAt).toBe(ev.ts) // stamped from the canonical event ts
    expect(must(notes[0], 'notes[0]').revision).toBe(1)
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
    const poison = eventFixture({
      seq: ++seq, projectId: 'p', taskId: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'BAD ID WITH SPACES' }, author: { source: 'agent', workspaceId: TEST_WORKSPACE_ID } },
      ts: '2026-01-01T00:00:59.000Z',
    })
    const notes = foldPlanNotes([poison, written({ id: 'masterplan', scope, tier: 'plan', title: 'M' })], scope)
    expect(notes.map(n => n.id)).toEqual(['masterplan'])
  })
})

// The grounded strategy exists to DECOMPOSE. A plan step that signals success without freezing a
// split did not do its job — and the run reported success anyway, with an empty plan graph. This
// happened on a real run: the agent verified the analyze step's work itself and passed.
describe('groundedPlanOmission', () => {
  const runToken = 'step:t1:plan:a1'
  const grounded = (over: Partial<EventRecord> = {}): EventRecord => eventFixture({
    projectId: 'p', kind: EVENT_KIND.plan_proposed, ts: '2026-07-24T00:00:00.000Z',
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

describe('withCommitStep', () => {
  const frozen = () => instantiateFrozenPlan('masterplan', [
    note({ id: 'masterplan', links: [link('db', LINK_KIND.decomposes_into), link('verify', LINK_KIND.decomposes_into)] }),
    note({ id: 'db', body: 'do it' }),
    note({ id: 'verify', body: 'check it', dependsOn: ['db'] }),
  ])

  it('appends the kernel-owned trailing commit step, ordered after every sibling', () => {
    const draft = withCommitStep(frozen())
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'verify', 'commit'])
    const commit = must(draft.steps.at(-1), 'draft.steps.at(-1)')
    expect(commit).toEqual({
      id: COMMIT_STEP_ID, role: STEP_ROLE.committer, title: 'Commit',
      instructions: "Commit this task's changes; the 'role-committer' skill is your contract.", dependsOn: ['db', 'verify'],
      skillRefs: [ROLE_SKILL.committer], toolRefs: [], zone: [], readOnlySource: true,
    })
  })

  it('refuses a plan that already carries a step named commit — loud, never a silent shadow', () => {
    const clash = { steps: [...frozen().steps, { ...must(frozen().steps[0], 'first frozen step'), id: 'commit', dependsOn: [] }] }
    expect(() => withCommitStep(clash)).toThrow(/commit/)
  })

  it('the frozen verify step carries the role-auditor skill; implementers never do', () => {
    const verify = must(frozen().steps.find(s => s.id === 'verify'), 'frozen().steps.find(s => s.id === \'verify\')')
    expect(verify.skillRefs).toEqual([ROLE_SKILL.auditor])
    expect(must(frozen().steps.find(s => s.id === 'db'), 'frozen().steps.find(s => s.id === \'db\')').skillRefs).toEqual([])
  })
})

describe('withFinishStep', () => {
  // the same three notes withCommitStep's describe freezes — duplicated rather than shared, so a
  // change to one describe's fixture cannot silently retune the other's assertions
  const frozen = () => instantiateFrozenPlan('masterplan', [
    note({ id: 'masterplan', links: [link('db', LINK_KIND.decomposes_into), link('verify', LINK_KIND.decomposes_into)] }),
    note({ id: 'db', body: 'do it' }),
    note({ id: 'verify', body: 'check it', dependsOn: ['db'] }),
  ])
  const notes = (): PlanNote[] => [
    note({ id: 'masterplan', links: [link('db', LINK_KIND.decomposes_into), link('verify', LINK_KIND.decomposes_into)] }),
    note({ id: 'db', body: 'do it' }),
    note({ id: 'verify', body: 'check it', dependsOn: ['db'] }),
  ]

  it('appends the kernel-owned finish step after every sibling, and the commit step after it', () => {
    const draft = withCommitStep(withFinishStep(frozen()))
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'verify', FINISH_STEP_ID, COMMIT_STEP_ID])
    const finish = draft.steps.find(s => s.id === FINISH_STEP_ID)
    expect(finish).toEqual({
      id: FINISH_STEP_ID, role: STEP_ROLE.finisher, title: 'Finish',
      instructions: "Reconcile this task's notes, record its decision if it made one, and present the summary; the 'role-finisher' skill is your contract.",
      dependsOn: ['db', 'verify'], skillRefs: [ROLE_SKILL.finisher], toolRefs: [], zone: [], readOnlySource: true,
    })
    // the commit stamp must see reconciled notes, so it waits on the finish step too
    expect(draft.steps.at(-1)?.dependsOn).toEqual(['db', 'verify', FINISH_STEP_ID])
  })

  it('freezePlan always carries the finish step, with or without autoCommit', () => {
    expect(freezePlan('masterplan', notes(), { autoCommit: false }).steps.map(s => s.id)).toEqual(['db', 'verify', FINISH_STEP_ID])
    expect(freezePlan('masterplan', notes(), { autoCommit: true }).steps.map(s => s.id)).toEqual(['db', 'verify', FINISH_STEP_ID, COMMIT_STEP_ID])
  })

  // the blank-plan refusal (instantiateFrozenPlan) stays AHEAD of the append: a childless masterplan
  // must never freeze to a finish-only pipeline that asks the human to summarize nothing — the same
  // silent-failure shape the commit-only pipeline had (incidents c4bc1d38, 8b5e1034)
  it('never turns a childless masterplan into a finish-only pipeline — the blank-plan refusal comes first', () => {
    expect(() => freezePlan('masterplan', [note({ id: 'masterplan', title: 'M', links: [] })], { autoCommit: false })).toThrow(/decomposes_into/)
  })

  it('refuses a plan that already names finish', () => {
    const first = frozen().steps[0]
    if (!first) throw new Error('fixture must freeze at least one step')
    const clash = { steps: [...frozen().steps, { ...first, id: FINISH_STEP_ID, dependsOn: [] }] }
    expect(() => withFinishStep(clash)).toThrow(/finish/)
  })
})
