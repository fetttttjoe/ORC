import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_KIND } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { createTestDb, TEST_PROJECT_ID } from '../test-helpers'

const FIXTURE = fileURLToPath(new URL('./resume-fixture.ts', import.meta.url))

describe('kill -9 resume (spec §10/§11 — the crown jewel)', () => {
  let drop: (() => Promise<void>) | null = null
  afterAll(async () => { await drop?.() })

  it('a killed run resumes on restart; no double-billed iteration; replay identity holds', async () => {
    const db = await createTestDb()
    drop = db.drop
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'resume me', spec: 'survive kill -9' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ title: 'slow', instructions: 'stall then finish' })]))
    await kernel.approvePlan(t.id)
    const marker = path.join(mkdtempSync(path.join(tmpdir(), 'orc-resume-')), 'first-run-started')

    // First run: spawn, wait for the marker (executor is now stalled mid-step), kill -9
    const first = Bun.spawn(['bun', FIXTURE, db.url, t.id, marker], { stdout: 'pipe', stderr: 'pipe' })
    const deadline = Date.now() + 30_000
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('fixture never reached the stall point')
      await new Promise(r => setTimeout(r, 100))
    }
    first.kill(9)
    await first.exited

    // Second run: recovery + idempotent attach must complete the task
    const second = Bun.spawn(['bun', FIXTURE, db.url, t.id, marker], { stdout: 'pipe', stderr: 'pipe' })
    const code = await second.exited
    expect(code).toBe(0)

    // task done: the kill lands inside the operation (after operation_started committed,
    // before completion), so the journal shows honest before/after continuity — attempt 1
    // began and vanished, attempt 2 completed. Domain events stay single: one agent_call.
    expect((await kernel.getTask(t.id))?.status).toBe('done')
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('s1')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('s1')?.iterations).toBe(1)
    expect(state.usage.get(t.id)?.inputTokens).toBe(1) // completion drafts ran once, so usage is recorded once

    // the interrupted operation is a single logical node: two start transitions, one final
    // completion, attempts=2 — never a blind gap, never a double effect.
    const ops = await storage.operations.operationsFor(t.id)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.status).toBe('completed')
    expect(ops[0]!.attempts).toBe(2)
    const taskEvents = await log.byTask(t.id)
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.operation_started)).toHaveLength(2)
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.operation_completed)).toHaveLength(1)
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(1)

    // replay identity (extends M1's guarantee to execution events)
    const events = await log.all()
    expect(fold(events)).toEqual(fold(events))
    const reopened = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    expect(fold(await reopened.all())).toEqual(state)
    await reopened.close()
    await log.close()
  }, 120_000)
})
