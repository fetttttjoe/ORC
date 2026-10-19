import { afterAll, describe, expect, it } from 'bun:test'
import { CHECKS_EXECUTOR_REF, CHECKS_STEP_ID, Door, FINISH_STEP_ID, NO_CHAT, TaskType } from '@orc/contracts'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { derivedPlanBlock, renderDerivedPlan, renderPlanHuman } from './plan-render'
import { singleStepDraft } from './plan-template'

const plan = { version: 2, ...singleStepDraft({ title: 'summarize notes', spec: 'read notes.txt, write summary.md' }, 'anthropic/claude-haiku-4-5') }

describe('renderPlanHuman', () => {
  it('renders steps with model, rate, budget, and honest missing-estimate line', () => {
    const out = renderPlanHuman(plan, ref => (ref === 'anthropic/claude-haiku-4-5' ? '$1/M in · $5/M out' : null))
    expect(out).toContain('plan v2 · 1 step(s)')
    expect(out).toContain('cost estimate: none provided')
    expect(out).toContain('s1  [worker] summarize notes')
    expect(out).toContain('anthropic/claude-haiku-4-5 ($1/M in · $5/M out) · ≤30 iterations')
    expect(out).toContain('read notes.txt, write summary.md')
  })
  it('renders the checks step as its commands, with no model or iteration budget', () => {
    const [s1] = plan.steps
    if (s1 === undefined) throw new Error('the template has no step')
    const checks = { ...s1, id: CHECKS_STEP_ID, title: 'Checks', executorRef: CHECKS_EXECUTOR_REF, dependsOn: [s1.id], instructions: JSON.stringify(['bun run typecheck', 'bun test a.test.ts']) }
    const out = renderPlanHuman({ ...plan, steps: [s1, checks] })
    const at = out.split('\n').findIndex(l => l.includes('checks  ['))
    expect(out.split('\n').slice(at + 1, at + 4)).toEqual([
      '      no model — runs these commands concurrently and reports; a failure never blocks · after s1',
      '      $ bun run typecheck',
      '      $ bun test a.test.ts',
    ])
  })
  it('shows a provided estimate and survives a missing rate', () => {
    const out = renderPlanHuman({ ...plan, costEstimateUSD: 0.5 })
    expect(out).toContain('cost estimate: $0.50')
    expect(out).not.toContain('(null)')
  })
})

// Reproduced live 2026-07-26: the plan agent's prose said "verify depends on draft"; the verify
// plan-note had links: []. finalize_plan froze dependsOn: [] and the two raced. The plan hash binds
// the human's approval to the note graph — which they were never shown.
describe('renderDerivedPlan', () => {
  const step = (id: string, dependsOn: string[] = [], zone: string[] = []) =>
    ({ id, role: 'implementer', title: id, instructions: 'x', dependsOn, skillRefs: [], toolRefs: [], zone })

  it('states each step’s real ordering, so prose claiming a sequence can be checked', () => {
    const out = renderDerivedPlan({ steps: [step('draft'), step('verify', ['draft'])] })
    expect(out).toContain('after draft')
    expect(out).not.toMatch(/unordered/)
  })

  it('calls out an all-unordered plan — the exact shape that raced', () => {
    const out = renderDerivedPlan({ steps: [step('draft'), step('verify')] })
    expect(out).toContain('no dependencies')
    expect(out).toMatch(/unordered/)
  })

  it('shows the write fence, so two steps aimed at one file are visible', () => {
    expect(renderDerivedPlan({ steps: [step('draft', [], ['docs/page.md'])] })).toContain('docs/page.md')
  })
})

describe('derivedPlanBlock (the gate shows what the kernel-held notes freeze to)', () => {
  const CLI = NO_CHAT(Door.cli)
  const cleanup: Array<() => Promise<void>> = []
  afterAll(async () => { for (const c of cleanup.reverse()) await c() })

  const groundedTask = async () => {
    const db = await createTestDb()
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    cleanup.push(() => db.drop(), () => storage.close())
    await seedTestWorkspace(storage.events, CLI)
    const kernel = new Kernel(storage.events)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: TaskType.grounded }, CLI)
    return { kernel, taskId: t.id }
  }

  it('renders both subplans and the finish step the freeze appends', async () => {
    const { kernel, taskId } = await groundedTask()
    await kernel.writePlanNote(taskId, { id: 'masterplan', title: 'Plan', subplans: ['schema', 'endpoints'] }, CLI)
    await kernel.writePlanNote(taskId, { id: 'schema', title: 'Schema' }, CLI)
    await kernel.writePlanNote(taskId, { id: 'endpoints', title: 'Endpoints', dependsOn: ['schema'] }, CLI)

    const out = await derivedPlanBlock(kernel, { checks: [] }, taskId)

    expect(out).toContain('schema')
    expect(out).toContain('endpoints')
    expect(out).toContain('after schema')
    expect(out).toContain(FINISH_STEP_ID)
  })

  it('renders nothing before a masterplan exists', async () => {
    const { kernel, taskId } = await groundedTask()
    await kernel.writePlanNote(taskId, { id: 'schema', title: 'Schema' }, CLI)
    expect(await derivedPlanBlock(kernel, { checks: [] }, taskId)).toBe('')
  })

  it("renders a dangling subplan id as the freeze's error, never a crash", async () => {
    const { kernel, taskId } = await groundedTask()
    await kernel.writePlanNote(taskId, { id: 'masterplan', title: 'Plan', subplans: ['ghost'] }, CLI)
    const out = await derivedPlanBlock(kernel, { checks: [] }, taskId)
    expect(out).toStartWith('the plan notes do not derive a runnable plan: ')
    expect(out).toContain("'ghost'")
    expect(out).toContain('subplans')
  })
})
