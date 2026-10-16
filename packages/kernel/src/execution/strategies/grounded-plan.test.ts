import { describe, expect, it } from 'bun:test'
import { CHECKS_STEP_ID, COMMIT_STEP_ID, EVENT_KIND, FINISH_STEP_ID, PlanNoteToolName, ROLE_SKILL, STEP_ROLE, type EventRecord, type PlanNote } from '@orc/contracts'
import { eventFixture, must, planNoteFixture, stepFixture } from '@orc/contracts/fixtures'
import { freezePlan, groundedPlanOmission, instantiateFrozenPlan, planGraphHash, withCommitStep } from './grounded-plan'
// the appender lives in the pure module now (finish-step.ts, contracts-only imports); this describe
// stays here because its subject is what the FREEZE ends with, not the appender in isolation
import { withFinishStep } from '../../finish-step'

const note = (over: Partial<PlanNote> & { id: string }): PlanNote => planNoteFixture({ title: over.id, ...over })

describe('planGraphHash', () => {
  it('is canonical across note order and changes with reviewed graph content/order', () => {
    const hash = planGraphHash
    const notes = [
      note({ id: 'masterplan', subplans: ['a', 'b'] }),
      note({ id: 'a', body: 'A', uncertainty: ['verify A'] }),
      note({ id: 'b', body: 'B' }),
    ]
    const original = hash(notes)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
    expect(hash([...notes].reverse())).toBe(original)
    expect(hash(notes.map(n => n.id === 'a' ? { ...n, body: 'changed' } : n))).not.toBe(original)
    expect(hash(notes.map(n => n.id === 'masterplan' ? { ...n, subplans: [...n.subplans].reverse() } : n))).not.toBe(original)
    expect(hash(notes.map(n => n.id === 'a' ? { ...n, uncertainty: ['different'] } : n))).not.toBe(original)
  })
})

describe('instantiateFrozenPlan (pure, deterministic)', () => {
  it("translates the masterplan's subplans into steps and the dependsOn field into ordering", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['db', 'api'] }),
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
      note({ id: 'masterplan', subplans: ['a', 'b'] }),
      note({ id: 'a', title: 'A', body: 'x', zone: ['docs/**'] }),
      note({ id: 'b', title: 'B', body: 'y' }),
    ]
    const draft = instantiateFrozenPlan('masterplan', notes)
    expect(must(draft.steps.find(s => s.id === 'a'), 'draft.steps.find(s => s.id === \'a\')').zone).toEqual(['docs/**'])
    expect(must(draft.steps.find(s => s.id === 'b'), 'draft.steps.find(s => s.id === \'b\')').zone).toEqual([]) // undeclared = unfenced
  })

  it("freezes a 'verify' subplan as auditor; siblings stay implementer", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['work', 'verify'] }),
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
      note({ id: 'masterplan', subplans: ['work', 'verify'] }),
      note({ id: 'work', title: 'Work', body: 'do it' }),
      note({ id: 'verify', title: 'Verify', body: 'audit it', dependsOn: ['work'], skillRefs: [ROLE_SKILL.auditor] }),
    ]
    expect(must(instantiateFrozenPlan('masterplan', notes).steps.find(s => s.id === 'verify'), 'verify step').skillRefs).toEqual([ROLE_SKILL.auditor])
  })

  it('is a pure function of the notes: same input → identical output', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['a'] }),
      note({ id: 'a', title: 'A', summary: 'sum' }),
    ]
    expect(instantiateFrozenPlan('masterplan', notes)).toEqual(instantiateFrozenPlan('masterplan', notes))
    // instructions fall back title→summary→body: empty body uses summary
    expect(must(instantiateFrozenPlan('masterplan', notes).steps[0], 'instantiateFrozenPlan(\'masterplan\', notes).steps[0]').instructions).toBe('sum')
  })

  it('takes ordering from the dependsOn field', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['a', 'b'] }),
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
      note({ id: 'masterplan', subplans: ['a-read', 'a-write', 'b'] }),
      note({ id: 'a-read', title: 'A read' }),
      note({ id: 'a-write', title: 'A write' }),
      note({ id: 'b', title: 'B', dependsOn: ['a'] }), // 'a' no longer exists
    ]
    const b = must(instantiateFrozenPlan('masterplan', notes).steps.find(s => s.id === 'b'), 'step b')
    expect(b.dependsOn).toEqual(['a-read', 'a-write']) // never [], never containing itself
  })

  it('the heal stays deterministic and never self-depends', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['a', 'b'] }),
      note({ id: 'a', title: 'A', dependsOn: ['gone'] }),
      note({ id: 'b', title: 'B' }),
    ]
    const first = instantiateFrozenPlan('masterplan', notes)
    expect(must(first.steps.find(s => s.id === 'a'), 'first.steps.find(s => s.id === \'a\')').dependsOn).toEqual(['b'])
    expect(first).toEqual(instantiateFrozenPlan('masterplan', notes))
  })

  // A masterplan with no subplans freezes to steps: [] — and with autoCommit on, withCommitStep then
  // appends a commit step, yielding a commit-only pipeline that reports done having written no code
  // (incidents c4bc1d38, 8b5e1034). Refuse at the freeze — the ONE derivation — naming the field.
  it('refuses a masterplan with no subplans, naming the field', () => {
    expect(() => instantiateFrozenPlan('masterplan', [note({ id: 'masterplan', title: 'M' })])).toThrow(/subplans/)
  })

  it('refuses a subplan id no plan note carries, naming the field and the id', () => {
    const notes: PlanNote[] = [note({ id: 'masterplan', subplans: ['a', 'ghost'] }), note({ id: 'a' })]
    expect(() => instantiateFrozenPlan('masterplan', notes)).toThrow(/'ghost'/)
    expect(() => instantiateFrozenPlan('masterplan', notes)).toThrow(/subplans/)
  })

  it("leads a subplan's step with its rationale on a Why: line, then the body, then the reviewed uncertainty", () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['a'] }),
      note({ id: 'a', body: 'do the thing', rationale: 'the api needs it', uncertainty: ['is X wired?'] }),
    ]
    expect(must(instantiateFrozenPlan('masterplan', notes).steps[0], 'step a').instructions).toBe(
      'Why: the api needs it\n\ndo the thing\n\nUnresolved uncertainty (reviewed at approval — act on these, do not skip):\n- is X wired?')
  })

  // A reviewed uncertainty entry is load-bearing material the human approved along with the rest
  // of the plan note — dropping it silently at the freeze means the executing agent never sees it.
  it('appends reviewed uncertainty entries to the derived instructions', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['a'] }),
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
      note({ id: 'masterplan', subplans: ['a'] }),
      note({ id: 'a', title: 'A', body: 'do the thing' }),
    ]
    const n = must(notes.find(x => x.id === 'a'), 'notes.find(x => x.id === \'a\')')
    const instructions = must(instantiateFrozenPlan('masterplan', notes).steps[0], 'instantiateFrozenPlan(\'masterplan\', notes).steps[0]').instructions
    expect(instructions).toBe(n.body || n.summary || n.title)
    expect(instructions).toBe('do the thing')
  })
})

  // a subplan's step gets only what its note declares — before this, toolRefs/skillRefs were
  // hardcoded empty, so a grounded plan could decompose work but never grant the capability to do
  // it: a research subplan reached execution with no way to search.
  it('freezes the capabilities a subplan declares into its step', () => {
    const notes: PlanNote[] = [
      note({ id: 'masterplan', subplans: ['research', 'local'] }),
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

  it('refuses a plan step that signalled success without freezing a split, naming the tool and not the task', () => {
    const taskId = '7f1c2a9e-3b4d-4e5f-8a6b-9c0d1e2f3a4b'
    const reason = groundedPlanOmission([grounded({ taskId })], 'plan', runToken)
    expect(reason).toContain(PlanNoteToolName.finalize)
    expect(reason).toContain('masterplan')
    expect(reason).toContain(PlanNoteToolName.write)
    expect(reason).toContain('subplans')
    expect(reason).not.toContain(taskId)
  })

  it('accepts a plan step that proposed its split', () => {
    expect(groundedPlanOmission([grounded(), split(runToken)], 'plan', runToken)).toBeNull()
  })

  // a split from an EARLIER attempt is not this attempt's work — the check is per runToken
  it('does not accept another attempt\'s split', () => {
    expect(groundedPlanOmission([grounded(), split('step:t1:plan:a0')], 'plan', runToken)).toContain(PlanNoteToolName.finalize)
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
    note({ id: 'masterplan', subplans: ['db', 'verify'] }),
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
    note({ id: 'masterplan', subplans: ['db', 'verify'] }),
    note({ id: 'db', body: 'do it' }),
    note({ id: 'verify', body: 'check it', dependsOn: ['db'] }),
  ])
  const notes = (): PlanNote[] => [
    note({ id: 'masterplan', subplans: ['db', 'verify'] }),
    note({ id: 'db', body: 'do it' }),
    note({ id: 'verify', body: 'check it', dependsOn: ['db'] }),
  ]

  it('appends the kernel-owned finish step after every sibling, and the commit step after it', () => {
    const draft = withCommitStep(withFinishStep(frozen(), { checks: [] }))
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'verify', FINISH_STEP_ID, COMMIT_STEP_ID])
    const finish = draft.steps.find(s => s.id === FINISH_STEP_ID)
    expect(finish).toEqual({
      id: FINISH_STEP_ID, role: STEP_ROLE.finisher, title: 'Finish',
      instructions: "Reconcile the claims this task recorded, record its decision if it made one, and present the summary; the 'role-finisher' skill is your contract.",
      dependsOn: ['db', 'verify'], skillRefs: [ROLE_SKILL.finisher], toolRefs: [], zone: [], readOnlySource: true,
    })
    // the commit stamp must see reconciled notes, so it waits on the finish step too
    expect(draft.steps.at(-1)?.dependsOn).toEqual(['db', 'verify', FINISH_STEP_ID])
  })

  it('freezePlan always carries the finish step, with or without autoCommit', () => {
    expect(freezePlan('masterplan', notes(), { autoCommit: false, checks: [] }).steps.map(s => s.id)).toEqual(['db', 'verify', FINISH_STEP_ID])
    expect(freezePlan('masterplan', notes(), { autoCommit: true, checks: [] }).steps.map(s => s.id)).toEqual(['db', 'verify', FINISH_STEP_ID, COMMIT_STEP_ID])
  })

  it('with no configured checks the frozen plan carries no checks step', () => {
    const draft = freezePlan('masterplan', notes(), { autoCommit: true, checks: [] })
    expect(draft.steps.map(s => s.id)).not.toContain(CHECKS_STEP_ID)
    expect(draft.steps.find(s => s.id === FINISH_STEP_ID)?.dependsOn).toEqual(['db', 'verify'])
  })

  it('configured checks freeze as a checks step every sibling precedes, with finish waiting on it', () => {
    const draft = freezePlan('masterplan', notes(), { autoCommit: false, checks: ['bun test x.ts', 'bun run typecheck'] })
    expect(draft.steps.map(s => s.id)).toEqual(['db', 'verify', CHECKS_STEP_ID, FINISH_STEP_ID])
    expect(draft.steps.find(s => s.id === CHECKS_STEP_ID)).toEqual({
      id: CHECKS_STEP_ID, role: STEP_ROLE.worker, title: 'Checks',
      instructions: JSON.stringify(['bun test x.ts', 'bun run typecheck']),
      dependsOn: ['db', 'verify'], skillRefs: [], toolRefs: [], zone: [], readOnlySource: true,
    })
    expect(draft.steps.at(-1)?.dependsOn).toEqual(['db', 'verify', CHECKS_STEP_ID])
  })

  // the blank-plan refusal (instantiateFrozenPlan) stays AHEAD of the append: a childless masterplan
  // must never freeze to a finish-only pipeline that asks the human to summarize nothing — the same
  // silent-failure shape the commit-only pipeline had (incidents c4bc1d38, 8b5e1034)
  it('never turns a childless masterplan into a finish-only pipeline — the blank-plan refusal comes first', () => {
    expect(() => freezePlan('masterplan', [note({ id: 'masterplan', title: 'M' })], { autoCommit: false, checks: [] })).toThrow(/subplans/)
  })

  it('refuses a plan that already names finish', () => {
    const first = frozen().steps[0]
    if (!first) throw new Error('fixture must freeze at least one step')
    const clash = { steps: [...frozen().steps, { ...first, id: FINISH_STEP_ID, dependsOn: [] }] }
    expect(() => withFinishStep(clash, { checks: [] })).toThrow(/finish/)
  })

  it('refuses a plan that already names checks', () => {
    const first = frozen().steps[0]
    if (!first) throw new Error('fixture must freeze at least one step')
    const clash = { steps: [...frozen().steps, { ...first, id: CHECKS_STEP_ID, dependsOn: [] }] }
    expect(() => withFinishStep(clash, { checks: [] })).toThrow(/checks/)
  })
})
