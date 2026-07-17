import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Checkpoint, EventDraft, ExecutorContext, UnifiedEvent } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import type { LanguageModel } from 'ai'
import { apiLoopExecutor } from './loop'

// test-double checkpoint: runs fn, captures drafted events (what DBOS would append durably)
function makeCheckpoint(captured: EventDraft[]): Checkpoint {
  return async (_name, fn, toEvents) => {
    const r = await fn()
    if (toEvents) captured.push(...toEvents(r))
    return r
  }
}

function ctx(model: LanguageModel, captured: EventDraft[], over: Partial<ExecutorContext<LanguageModel>> = {}): ExecutorContext<LanguageModel> {
  return {
    step: {
      id: 's1', role: 'worker', title: 't', instructions: 'do the thing',
      executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [],
      isolation: 'local', zone: [], maxIterations: 3, dependsOn: [],
    },
    taskSpec: 'the task',
    depOutputs: {},
    model,
    runToken: 'step:t1:s1:a1',
    workspaceDir: mkdtempSync(path.join(tmpdir(), 'orc-ws-')),
    checkpoint: makeCheckpoint(captured),
    budgetRemainingUSD: async () => null,
    ...over,
  }
}

async function drain(it: AsyncIterable<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const out: UnifiedEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// Build mock models per scenario. See the step preamble: construct with the installed
// 'ai/test' mock class; each doGenerate call pops the next scripted response.
// scriptModel(responses: Array<{ text?: string; toolCalls?: Array<{toolCallId,toolName,input}> }>): LanguageModel
import { scriptModel } from './test-model'

describe('api-loop executor', () => {
  it('signal on first turn → signal + done events, agent_call + signal_received drafted', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'all good' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.map(e => e.type)).toEqual(['usage', 'signal', 'done'])
    const kinds = captured.map(d => d.kind)
    expect(kinds).toContain(EVENT_KIND.agent_call)
    expect(kinds).toContain(EVENT_KIND.signal_received)
  })

  it('tool call → executes → feeds result back → signal on turn 2', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'fs_write', input: { path: 'out.txt', content: 'hi' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'wrote file' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('done')
    const toolDrafts = captured.filter(d => d.kind === EVENT_KIND.tool_call || d.kind === EVENT_KIND.tool_result)
    expect(toolDrafts).toHaveLength(2)
  })

  it('agent-declared failure → signal(outcome failure), no done-as-success ambiguity', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'failure', summary: 'cannot proceed' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    const sig = events.find(e => e.type === 'signal')
    expect(sig?.type === 'signal' && sig.signal.outcome).toBe('failure')
  })

  it('never signals → maxIterations exhausted → error(agent_error)', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([{ text: 'hm' }, { text: 'hm' }, { text: 'hm' }])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.type === 'error' && last.class).toBe('agent_error')
  })

  it('budget exhausted → error(budget_exceeded) before any model call', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([])
    const events = await drain(
      apiLoopExecutor().startTurn(ctx(model, captured, { budgetRemainingUSD: async () => 0 })),
    )
    expect(events.at(-1)?.type === 'error' && (events.at(-1) as { class: string }).class).toBe('budget_exceeded')
    expect(captured.filter(d => d.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('malformed signal args count as an iteration and the loop continues', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'maybe' } }] }, // invalid
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'ok now' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.at(-1)?.type).toBe('done')
  })
})
