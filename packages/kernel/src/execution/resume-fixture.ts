// Subprocess entry for the kill -9 resume test. Args: <dbUrl> <taskId> <markerPath>
// A fake executor stalls 60s inside its first model checkpoint UNLESS the marker file
// already exists (i.e. we are the respawned process) — first run: create marker, stall,
// get killed; second run: DBOS recovery + idempotent startRun complete the run fast.
import { existsSync, writeFileSync } from 'node:fs'
import {
  EVENT_KIND, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort } from './dbos-port'

const [dbUrl, taskId, marker] = process.argv.slice(2) as [string, string, string]

const stallOnce: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    await ctx.checkpoint(
      'model:1',
      async () => {
        if (!existsSync(marker)) {
          writeFileSync(marker, '')
          await new Promise(r => setTimeout(r, 60_000)) // killed here on first run
        }
        return 'turn'
      },
      (): EventDraft[] => [{
        kind: EVENT_KIND.agent_call,
        payload: { stepId: ctx.step.id, runToken: ctx.runToken, iteration: 1, request: {}, response: {} },
        usage: { inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false },
      }],
    )
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: `${ctx.step.id} ok` }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

const log = await EventLog.open(dbUrl, { projectId: TEST_PROJECT_ID })
const config = testConfig(dbUrl)
const port = await createDbosPort({
  log, config,
  providers: new Map([['fake', fakeProvider]]),
  executors: new Map([['api-loop', stallOnce]]),
})
await port.launch() // recovery of PENDING workflows happens here on the respawn
const handle = await port.startRun(taskId) // idempotent: attaches on respawn
const outcome = await handle.wait()
await port.shutdown()
await log.close()
console.log(outcome)
process.exit(outcome === 'done' ? 0 : 1)
