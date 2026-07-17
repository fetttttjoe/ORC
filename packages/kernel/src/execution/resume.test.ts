import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_KIND } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { createTestDb } from '../test-helpers'

const FIXTURE = fileURLToPath(new URL('./resume-fixture.ts', import.meta.url))

describe('kill -9 resume (spec §10/§11 — the crown jewel)', () => {
  let drop: (() => Promise<void>) | null = null
  afterAll(async () => { await drop?.() })

  it('a killed run resumes on restart; no double-billed iteration; replay identity holds', async () => {
    const db = await createTestDb()
    drop = db.drop
    const log = await EventLog.open(db.url)
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

    // task done: the kill lands inside the uncommitted step (before its checkpoint fn
    // resolves), so the crashed attempt appends zero events — recovery re-runs the step
    // clean from scratch, giving exactly one effective iteration. (True crash-boundary
    // duplicates, where a partial event WAS appended before the kill, are covered by the
    // crashDedupKey unit tests in projections.test.ts and the dbos-port idempotency test.)
    expect((await kernel.getTask(t.id))?.status).toBe('done')
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('s1')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('s1')?.iterations).toBe(1)
    expect(state.usage.get(t.id)?.inputTokens).toBe(1) // one checkpoint ever ran, so usage is recorded once

    // explicit enforcement: the killed attempt left no partial agent_call behind, so
    // exactly one was ever recorded, for exactly one billed model call.
    const taskEvents = await log.byTask(t.id)
    expect(taskEvents.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(1)

    // replay identity (extends M1's guarantee to execution events)
    const events = await log.all()
    expect(fold(events)).toEqual(fold(events))
    const reopened = await EventLog.open(db.url)
    expect(fold(await reopened.all())).toEqual(state)
    await reopened.close()
    await log.close()
  }, 120_000)
})
