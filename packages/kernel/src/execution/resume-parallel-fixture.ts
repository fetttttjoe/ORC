// Subprocess entry for the parallel kill -9 resume test. Args: <dbUrl> <taskId> <markerDir>
//
// Four steps: `a` and `b` independent, `c` dependsOn `a`, `d` dependsOn `b`. `a` finishes
// slower than `b`, so the FIRST run settles b-then-a and therefore launches d-then-c from
// inside the scheduling loop. On replay both results are already recorded, so every promise
// is pre-settled and the loop settles in Map insertion order (a-then-b) instead — launching
// c-then-d. That order divergence is the whole point of this fixture: DBOS binds child
// handles positionally, so a scheduler whose launch order depends on settle timing hands
// each dependent the other's workflow handle on recovery.
//
// `c` and `d` stall until kill -9 on the first run (announcing themselves via marker files
// so the test knows both are in flight) and complete immediately on the respawn.
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  EVENT_KIND, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { openStorage } from '../storage'
import { fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort } from './dbos-port'

const [dbUrl, taskId, markerDir] = process.argv.slice(2)
if (!dbUrl || !taskId || !markerDir) throw new Error('usage: resume-parallel-fixture <dbUrl> <taskId> <markerDir>')

const marker = (name: string): string => path.join(markerDir, name)
const STALLS = new Set(['c', 'd'])

// Ordering handshake: `a` blocks until `b` has run, so `b` always settles first on the first
// run. A bare delay was flaky here — step startup latency routinely exceeded it and the two
// settled in plan order, hiding the divergence.
//
// It keys off `b`, deliberately, and NOT off `d` having started: a dependent cannot start
// until its whole wave finishes, so waiting on `d` would deadlock wave scheduling. This
// handshake holds under both schedulers.
const awaitFile = async (file: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`ordering handshake timed out waiting for ${file}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

const scheduled: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    const id = ctx.step.id
    if (STALLS.has(id)) {
      const own = marker(`${id}-started`)
      if (!existsSync(own)) {
        writeFileSync(own, '')
        await new Promise(r => setTimeout(r, 60_000)) // killed here on the first run
      }
    } else if (id === 'b') {
      writeFileSync(marker('b-done'), '')
    } else if (id === 'a' && !existsSync(marker('b-done'))) {
      await awaitFile(marker('b-done'))
      await new Promise(r => setTimeout(r, 2_000)) // let b's result reach the parent before a settles
    }
    const signal = { stepId: id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: `${id} ok` }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

const storage = await openStorage(dbUrl, { projectId: TEST_PROJECT_ID })
const log = storage.events
// concurrency > 1: `a` and `b` must be able to run at the same time, or they settle serially
// in plan order and the recovery divergence this fixture exists to catch never arises.
const config = testConfig(dbUrl, { concurrency: 4 })
const port = await createDbosPort({
  storage, config,
  providers: new Map([['fake', fakeProvider]]),
  executors: new Map([['api-loop', scheduled]]),
})
await port.launch() // recovery of PENDING workflows happens here on the respawn
const handle = await port.startRun(taskId) // idempotent: attaches on respawn
const outcome = await handle.wait()
await port.shutdown()
await log.close()
console.log(outcome)
process.exit(outcome === 'done' ? 0 : 1)
