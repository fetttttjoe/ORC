import { afterAll, describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, composeAuthor, Door, FINISH_STEP_ID, STEP_ROLE, type MemoryAuthor } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { DECISION_REFUSAL, type DecisionDoor } from './decisions'
import { finishTools, FINISH_TOOL_NAME } from './finish-tools'
import { createLiveMemory, type LiveMemory } from './test-helpers'

const lives: LiveMemory[] = []
afterAll(async () => { await Promise.all(lives.map(l => l.close())) }, 30_000)

// A finisher step writes from inside its run, so its origin is the run's own chat.
const author: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, origin: { chatId: 'run:t1:v1', door: Door.supervisor } })

// The author the PORT actually hands this step (runtime.ts's stepTools): source + workspace + task
// off the TaskNode, then executor/model/role read off the RUNNING step — `executor` is the step's
// executorRef ('api-loop'), `model` the RESOLVED model id (dbos-port's `model: modelId`, so
// 'fake/m' arrives here as 'm'), `role` the finisher role the kernel set. composeAuthor therefore
// renders 'api-loop·m·finisher'.
//
// The fixture used to pass `{ executor: 'finisher' }` with no model and no role — a shape
// production never produces, whose composeAuthor output is the bare word 'finisher'. That made the
// assertion below pass while saying nothing: the port could have stopped forwarding `model` and
// `role` entirely and this test would still have been green.
const stepAuthor: MemoryAuthor = {
  ...author, taskId: 't1', executor: 'api-loop', model: 'm', role: STEP_ROLE.finisher,
}

// the decisions.test.ts helper shape: a live stack that also satisfies DecisionDoor, so the tools
// run against the real event-first write path rather than a fake store
async function door(): Promise<DecisionDoor & { live: LiveMemory }> {
  const live = await createLiveMemory()
  lives.push(live)
  return { live, store: live.store, catchUp: () => live.projector.catchUp() }
}

const p = (over: Partial<{ stepId: string; role: string }> = {}) =>
  ({ taskId: 't1', stepId: FINISH_STEP_ID, role: STEP_ROLE.finisher, ...over })

describe('finish tools', () => {
  it('registers record_decision ONLY on the finish step with the finisher role', async () => {
    const live = await door()
    const names = (q: ReturnType<typeof p>) => finishTools({ door: live, author, p: q }).map(t => t.name)
    expect(new Set(names(p()))).toEqual(new Set([FINISH_TOOL_NAME.recordDecision]))
    // both terms, like the commit gate: a planner-authored step named 'finish' and a split claiming
    // the finisher role each get neither tool
    expect(names(p({ role: STEP_ROLE.worker }))).toEqual([])
    expect(names(p({ stepId: 'wrap-up' }))).toEqual([])
  }, 30_000)

  it('record_decision writes through the op with the STEP\'s author and refuses a second record of the same title', async () => {
    const live = await door()
    const tool = finishTools({ door: live, author: stepAuthor, p: p() })
      .find(t => t.name === FINISH_TOOL_NAME.recordDecision)
    const ok = await tool?.execute({ title: 'Log is truth', context: 'c', decision: 'd', consequences: 'q' }, undefined)
    expect(ok?.isError).toBe(false)
    const n = await live.store.get('log-is-truth')
    // composeAuthor, not a re-typed literal: the assertion is "the note names the STEP's author",
    // and spelling the rendering out here would pin composeAuthor's format as a second copy.
    expect(n?.createdBy).toBe(composeAuthor(stepAuthor))
    // supersession is a human act — the step's second attempt is refused with the lifecycle's own
    // sentence, not a tool-local restatement of it
    const again = await tool?.execute({ title: 'Log is truth', context: 'c', decision: 'd', consequences: 'q' }, undefined)
    expect(again?.isError).toBe(true)
    expect(JSON.stringify(again?.output)).toContain(DECISION_REFUSAL.exists('log-is-truth'))
  }, 30_000)

  // A tool that VANISHES when memory is degraded reads as "there is no decision to record"; one that
  // says "unavailable" reads as what it is. Same posture every other memory tool takes.
  it('with the read model down, record_decision is still listed and says memory is unavailable', async () => {
    const tools = finishTools({ door: null, author, p: p() })
    expect(tools.map(t => t.name)).toContain(FINISH_TOOL_NAME.recordDecision)
    const r = await tools.find(t => t.name === FINISH_TOOL_NAME.recordDecision)?.execute(
      { title: 'T', context: 'c', decision: 'd', consequences: 'q' }, undefined)
    expect(r?.isError).toBe(true)
    expect(JSON.stringify(r?.output)).toContain('memory unavailable')
  })
})
