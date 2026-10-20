// Subprocess entry for the parallel kill -9 resume test. Args: <dbUrl> <taskId> <markerDir>
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  EVENT_KIND, SignalOutcome,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { openStorage } from '../storage'
import { fakeProvider, fakeSkills, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort } from './dbos-port'

const [dbUrl, taskId, markerDir] = process.argv.slice(2)
if (!dbUrl || !taskId || !markerDir) throw new Error('usage: resume-parallel-fixture <dbUrl> <taskId> <markerDir>')

const marker = (name: string): string => path.join(markerDir, name)
// First run launches d-then-c, replay c-then-d; DBOS binds child handles positionally.
const STALLS = new Set(['c', 'd'])

// `a` waits on `b` so b settles first; it keys off b, as waiting on d would deadlock the waves
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
    const signal = { stepId: id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: `${id} ok` }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

const storage = await openStorage(dbUrl, { projectId: TEST_PROJECT_ID })
const log = storage.events
// concurrency > 1 so `a` and `b` run together; serial settling never diverges on recovery.
const config = testConfig(dbUrl, { concurrency: 4 })
const port = await createDbosPort({
  storage, config, skills: fakeSkills,
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
