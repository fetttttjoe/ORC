import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CHECKS_EXECUTOR_REF, CHECKS_STEP_ID, Door, EVENT_KIND, FINISH_STEP_ID, NO_CHAT, PAYLOAD_SCHEMAS, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type Origin, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, fakeSkills, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor } from '../test-helpers'
import { checksExecutor } from './checks-executor'
import { createDbosPort, dbosSend, type DbosPort } from './dbos-port'

const CLI: Origin = NO_CHAT(Door.cli)
const EXECUTOR_REF = 'checks-run-fake'
const RED_CHECK = 'sh red.sh'

// what the port handed each step as its upstream outputs, keyed by step id
const depOutputs = new Map<string, Record<string, string>>()

function recordingFake(): AgentExecutor<unknown> {
  return {
    id: EXECUTOR_REF,
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      depOutputs.set(ctx.step.id, ctx.depOutputs)
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: `${ctx.step.id} done` }
      await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
        { kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } },
      ])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

describe('a red check reports, it does not block', () => {
  let kernel: Kernel
  let port: DbosPort
  let workspaceDir: string
  let teardown: () => Promise<void>

  beforeAll(async () => {
    workspaceDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-checks-run-')))
    writeFileSync(path.join(workspaceDir, 'red.sh'), 'echo RED_TAIL 1>&2\nexit 3\n')
    const db = await createTestDb()
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    kernel = new Kernel(log, undefined, undefined, dbosSend, undefined, [RED_CHECK])
    await seedTestWorkspace(log, CLI, workspaceDir)
    port = await createDbosPort({
      storage, config: testConfig(db.url), skills: fakeSkills,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([[EXECUTOR_REF, recordingFake()], [CHECKS_EXECUTOR_REF, checksExecutor()]]),
    })
    await port.launch()
    teardown = async () => {
      await port.shutdown(); await log.close(); await db.drop()
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })
  afterAll(async () => { await teardown() })

  it('reaches the finish step with the FAIL verdict as an upstream output', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'checks test', spec: 'run the checks' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ executorRef: EXECUTOR_REF })]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)

    const handle = await port.startRun(t.id, { cwd: workspaceDir })
    expect(await handle.wait()).toBe('done')
    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.step_completed && e.stepId === FINISH_STEP_ID), 10_000)).toBe(true)

    const completed = (await kernel.eventsFor(t.id)).filter(e => e.kind === EVENT_KIND.step_completed)
    expect(completed.map(e => e.stepId)).toEqual(['s1', CHECKS_STEP_ID, FINISH_STEP_ID])

    const checks = must(completed.find(e => e.stepId === CHECKS_STEP_ID), 'checks step completed')
    expect(PAYLOAD_SCHEMAS.step_completed.parse(checks.payload).summary).toContain(`FAIL ${RED_CHECK} (exit 3,`)
    expect(depOutputs.get(FINISH_STEP_ID)?.[CHECKS_STEP_ID]).toContain(`FAIL ${RED_CHECK}`)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 60_000)
})
