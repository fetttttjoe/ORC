import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { createTestDb } from '../test-helpers'

const FIXTURE = fileURLToPath(new URL('./resume-fixture.ts', import.meta.url))

const singleStepDraft = {
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 'slow', instructions: 'stall then finish',
    executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 3, dependsOn: [],
  }],
} as const

describe('kill -9 resume (spec §10/§11 — the crown jewel)', () => {
  let drop: (() => Promise<void>) | null = null
  afterAll(async () => { await drop?.() })

  it('a killed run resumes on restart; no double-billed iteration; replay identity holds', async () => {
    const db = await createTestDb()
    drop = db.drop
    const log = await EventLog.open(db.url)
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'resume me', spec: 'survive kill -9' })
    await kernel.proposePlan(t.id, structuredClone(singleStepDraft) as never)
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

    // task done; the crash-boundary duplicate (if any) folds away: exactly ONE effective iteration
    expect((await kernel.getTask(t.id))?.status).toBe('done')
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('s1')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('s1')?.iterations).toBe(1)
    expect(state.usage.get(t.id)?.inputTokens).toBe(1) // usage counted once despite any replayed append

    // replay identity (extends M1's guarantee to execution events)
    const events = await log.all()
    expect(fold(events)).toEqual(fold(events))
    const reopened = await EventLog.open(db.url)
    expect(fold(await reopened.all())).toEqual(state)
    await reopened.close()
    await log.close()
  }, 120_000)
})
