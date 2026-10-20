import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Door, EVENT_KIND, FINISH_STEP_ID, NO_CHAT, OperationStatus, StepRunStatus, TASK_STATUS, type Origin } from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { fold, stepUsage } from '../projections'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '../test-helpers'

const FIXTURE = fileURLToPath(new URL('./resume-fixture.ts', import.meta.url))
const PARALLEL_FIXTURE = fileURLToPath(new URL('./resume-parallel-fixture.ts', import.meta.url))

const CLI: Origin = NO_CHAT(Door.cli)

const waitForFile = async (file: string, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(what)
    await new Promise(r => setTimeout(r, 100))
  }
}

describe('kill -9 resume', () => {
  // An array, not a single `drop`: a lone variable is overwritten and leaks the first database.
  const drops: (() => Promise<void>)[] = []
  afterAll(async () => { for (const d of drops) await d() })

  it('a killed run resumes on restart; no double-billed iteration; replay identity holds', async () => {
    const db = await createTestDb()
    drops.push(db.drop)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'resume me', spec: 'survive kill -9' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ title: 'slow', instructions: 'stall then finish' })]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    const marker = path.join(mkdtempSync(path.join(tmpdir(), 'orc-resume-')), 'first-run-started')

    // First run: spawn, wait for the marker (executor is now stalled mid-step), kill -9
    const first = Bun.spawn(['bun', FIXTURE, db.url, t.id, marker], { stdout: 'pipe', stderr: 'pipe' })
    await waitForFile(marker, 30_000, 'fixture never reached the stall point')
    first.kill(9)
    await first.exited

    // Second run: recovery + idempotent attach must complete the task
    const second = Bun.spawn(['bun', FIXTURE, db.url, t.id, marker], { stdout: 'pipe', stderr: 'pipe' })
    const code = await second.exited
    expect(code).toBe(0)

    // the kill lands inside the operation: attempt 1 began and vanished, attempt 2 completed
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('s1')?.status).toBe(StepRunStatus.completed)
    expect(state.steps.get(t.id)?.get('s1')?.iterations).toBe(1)
    // counted per step: the finish step runs the same executor and bills its own turn
    expect(stepUsage(state, t.id, 's1').inputTokens).toBe(1)
    expect(stepUsage(state, t.id, FINISH_STEP_ID).inputTokens).toBe(1)
    expect(state.usage.get(t.id)?.inputTokens).toBe(2)

    // one logical node: two start transitions, one completion, attempts=2; scoped to the killed step
    const ops = (await storage.operations.operationsFor(t.id)).filter(o => o.stepId === 's1')
    expect(ops).toHaveLength(1)
    expect(must(ops[0], 'first operation').status).toBe(OperationStatus.completed)
    expect(must(ops[0], 'first operation').attempts).toBe(2)
    const taskEvents = (await log.byTask(t.id)).filter(e => e.stepId === 's1')
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.operation_started)).toHaveLength(2)
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.operation_completed)).toHaveLength(1)
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(1)

    // replay identity (the fold is deterministic over execution events too)
    const events = await log.all()
    expect(fold(events)).toEqual(fold(events))
    const reopened = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    expect(fold(await reopened.all())).toEqual(state)
    await reopened.close()
    await log.close()
  }, 120_000)

  // Two steps settling in REVERSE plan order, each gating a dependent: where replay order can diverge
  it('two independent steps settling out of order resume with each result bound to its own step', async () => {
    const db = await createTestDb()
    drops.push(db.drop)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'resume me in parallel', spec: 'survive kill -9 with a wide plan' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([
      stepFixture({ id: 'a', title: 'a (slow)' }),
      stepFixture({ id: 'b', title: 'b (fast)' }),
      stepFixture({ id: 'c', title: 'c', dependsOn: ['a'] }),
      stepFixture({ id: 'd', title: 'd', dependsOn: ['b'] }),
    ]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    const markerDir = mkdtempSync(path.join(tmpdir(), 'orc-resume-parallel-'))

    // kill only once BOTH dependents are in flight: two recorded parents, two interrupted children
    const first = Bun.spawn(['bun', PARALLEL_FIXTURE, db.url, t.id, markerDir], { stdout: 'pipe', stderr: 'pipe' })
    await waitForFile(path.join(markerDir, 'c-started'), 60_000, 'fixture never launched step c')
    await waitForFile(path.join(markerDir, 'd-started'), 60_000, 'fixture never launched step d')
    first.kill(9)
    await first.exited

    // Bounded: a scheduler that mis-binds handles spins forever, so it must fail as a timeout
    const second = Bun.spawn(['bun', PARALLEL_FIXTURE, db.url, t.id, markerDir], { stdout: 'pipe', stderr: 'pipe' })
    const code = await Promise.race([
      second.exited,
      new Promise<null>(r => setTimeout(() => r(null), 90_000)),
    ])
    if (code === null) {
      second.kill(9)
      throw new Error('resumed run never finished — the scheduling loop hung instead of draining')
    }
    expect(code).toBe(0)

    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    const steps = (await kernel.state()).steps.get(t.id)
    // each id carries its OWN completion, not a sibling's — the positional-binding assertion
    for (const id of ['a', 'b', 'c', 'd']) expect(steps?.get(id)?.status).toBe(StepRunStatus.completed)
    await log.close()
  }, 180_000)
})
