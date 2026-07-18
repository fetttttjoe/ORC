import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Checkpoint, EventDraft, ExecutorContext, OperationCheckpoint, OperationSpec, ResolvedTool, SplitResult, UnifiedEvent } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
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

// test-double operation journal: same capture shape, keyed by spec instead of name
function makeOperation(captured: EventDraft[], specs: OperationSpec[] = []): OperationCheckpoint {
  return async (spec, fn, toEvents) => {
    specs.push(spec)
    const r = await fn()
    if (toEvents) captured.push(...toEvents(r))
    return r
  }
}

function ctx(model: LanguageModel, captured: EventDraft[], over: Partial<ExecutorContext<LanguageModel>> = {}): ExecutorContext<LanguageModel> {
  return {
    step: stepFixture({ instructions: 'do the thing', maxIterations: 3 }),
    taskSpec: 'the task',
    depOutputs: {},
    skills: [],
    extraTools: [],
    model,
    runToken: 'step:t1:s1:a1',
    workspaceDir: mkdtempSync(path.join(tmpdir(), 'orc-ws-')),
    checkpoint: makeCheckpoint(captured),
    operation: makeOperation(captured),
    budgetRemainingUSD: async () => null,
    ...over,
  }
}

async function drain(it: AsyncIterable<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const out: UnifiedEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// A real provider 400s a generateText call if any prior assistant tool-call id lacks a
// matching tool-result — every id that appears as a 'tool-call' part must also appear as a
// 'tool-result' part somewhere in the prompt built so far.
function unansweredToolCallIds(prompt: unknown): string[] {
  const messages = prompt as Array<{ content?: Array<{ type: string; toolCallId?: string }> }>
  const called = new Set<string>()
  const answered = new Set<string>()
  for (const m of messages) {
    for (const part of m.content ?? []) {
      if (part.type === 'tool-call' && part.toolCallId) called.add(part.toolCallId)
      if (part.type === 'tool-result' && part.toolCallId) answered.add(part.toolCallId)
    }
  }
  return [...called].filter(id => !answered.has(id))
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

    // Recovery must answer the unresolved 'signal' tool_use with a matching tool result —
    // otherwise a real provider 400s the follow-up request (unresolved tool_use block).
    const agentCallDrafts = captured.filter(d => d.kind === EVENT_KIND.agent_call)
    expect(agentCallDrafts).toHaveLength(2)
    const secondRequestMessages = (agentCallDrafts[1]!.payload as { request: { messages: Array<{ role: string; content: unknown }> } }).request.messages
    const recoveryMessage = secondRequestMessages.at(-1)
    expect(recoveryMessage?.role).toBe('tool')
    const parts = recoveryMessage?.content as Array<{ toolCallId: string; output: { value: { error: string } } }>
    expect(parts).toHaveLength(1)
    expect(parts[0]!.toolCallId).toBe('c1')
    expect(parts[0]!.output.value.error).toContain('invalid signal input')
  })

  it('agent_call drafts persist only the delta since the previous call, snapshotted', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'fs_write', input: { path: 'out.txt', content: 'hi' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'wrote file' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.at(-1)?.type).toBe('done')

    const agentCallDrafts = captured.filter(d => d.kind === EVENT_KIND.agent_call)
    expect(agentCallDrafts).toHaveLength(2)
    const messages1 = (agentCallDrafts[0]!.payload as { request: { messages: unknown[] } }).request.messages
    const messages2 = (agentCallDrafts[1]!.payload as { request: { messages: unknown[] } }).request.messages
    expect(messages1).toHaveLength(1) // the initial user prompt
    expect(messages2).toHaveLength(2) // ONLY what was appended since: assistant (tool call) + tool result
    // concatenated deltas reconstruct the full request history without O(n²) storage
    expect([...messages1, ...messages2].map(m => (m as { role: string }).role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('a valid signal batched with sibling tool calls executes the siblings first', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'c1', toolName: 'fs_write', input: { path: 'report.md', content: 'findings' } },
        { toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'wrote report' } },
      ] },
    ])
    const c = ctx(model, captured)
    const events = await drain(apiLoopExecutor().startTurn(c))

    // the write actually happened and was recorded before the signal completed the step
    expect(readFileSync(path.join(c.workspaceDir, 'report.md'), 'utf8')).toBe('findings')
    expect(events.map(e => e.type)).toEqual(['usage', 'tool_call', 'tool_result', 'signal', 'done'])
    const kinds = captured.map(d => d.kind)
    expect(kinds).toContain(EVENT_KIND.tool_call)
    expect(kinds).toContain(EVENT_KIND.tool_result)
    expect(kinds.indexOf(EVENT_KIND.tool_result)).toBeLessThan(kinds.indexOf(EVENT_KIND.signal_received))
  })

  it('renders force-loaded skills into the prompt', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'all good' } }] },
    ])
    const c = ctx(model, captured, { skills: [{ name: 'style-guide', body: 'Always write haiku.', hash: 'h' }] })
    const events = await drain(apiLoopExecutor().startTurn(c))
    expect(events.at(-1)?.type).toBe('done')

    const agentCallDrafts = captured.filter(d => d.kind === EVENT_KIND.agent_call)
    const firstRequestMessages = (agentCallDrafts[0]!.payload as { request: { messages: Array<{ role: string; content: unknown }> } }).request.messages
    expect(firstRequestMessages[0]?.content).toContain('# Skill: style-guide')
    expect(firstRequestMessages[0]?.content).toContain('Always write haiku.')
  })

  it('calls an extra tool end to end', async () => {
    const captured: EventDraft[] = []
    let seenToolCallId: string | undefined
    const extra: ResolvedTool = {
      ref: 'srv/hello',
      name: 'mcp__srv__hello',
      description: 'says hello',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
      execute: async (input, toolCallId) => { seenToolCallId = toolCallId; return { output: { hi: (input as { who?: string }).who }, isError: false } },
    }
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'mcp__srv__hello', input: { who: 'x' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'done' } }] },
    ])
    const c = ctx(model, captured, { extraTools: [extra] })
    const events = await drain(apiLoopExecutor().startTurn(c))

    expect(events.at(-1)?.type).toBe('done')
    const toolCallEvent = events.find(e => e.type === 'tool_call' && e.toolName === 'mcp__srv__hello')
    const toolResultEvent = events.find(e => e.type === 'tool_result' && e.toolName === 'mcp__srv__hello')
    expect(toolCallEvent).toBeDefined()
    expect(toolResultEvent?.type === 'tool_result' && toolResultEvent.output).toEqual({ hi: 'x' })
    expect(toolResultEvent?.type === 'tool_result' && toolResultEvent.isError).toBe(false)
    // the real provider tool_call id reaches ResolvedTool.execute — this is what lets
    // kernel/task_split derive a deterministic, non-colliding split id (Task 7)
    expect(seenToolCallId).toBe('c1')
  })

  it('join_splits yields a gate and feeds the resume value back as the tool result', async () => {
    const captured: EventDraft[] = []
    // turn 1: model calls join_splits; turn 2: model sees results and signals success
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'j1', toolName: 'join_splits', input: { splitIds: ['sp1'] } }] },
      { toolCalls: [{ toolCallId: 'sig', toolName: 'signal', input: { outcome: 'success', summary: 'joined' } }] },
    ])
    const gen = apiLoopExecutor().startTurn(ctx(model, captured))
    const events: UnifiedEvent[] = []
    let resume: SplitResult[] | undefined
    while (true) {
      const { value, done } = await gen.next(resume)
      resume = undefined
      if (done) break
      events.push(value)
      if (value.type === 'gate') {
        expect(value.splitIds).toEqual(['sp1'])
        resume = [{ splitId: 'sp1', childTaskId: 'c1', outcome: 'done', summary: 'child ok', notes: [{ id: 'n1', scope: 'project' }] }]
      }
    }
    expect(events.some(e => e.type === 'gate')).toBe(true)
    const result = events.find(e => e.type === 'tool_result' && e.toolCallId === 'j1')
    expect(result?.type === 'tool_result' && !result.isError).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
    // the model's second turn saw the split results in its tool message
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('child ok')
  })

  it('a valid signal batched with a valid join_splits defers the signal instead of dropping it', async () => {
    const captured: EventDraft[] = []
    // turn 1: model batches signal + join_splits together (premature signal); turn 2: it re-signals
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'sig1', toolName: 'signal', input: { outcome: 'success', summary: 'premature' } },
        { toolCallId: 'j1', toolName: 'join_splits', input: { splitIds: ['sp1'] } },
      ] },
      { toolCalls: [{ toolCallId: 'sig2', toolName: 'signal', input: { outcome: 'success', summary: 'joined for real' } }] },
    ])
    const gen = apiLoopExecutor().startTurn(ctx(model, captured))
    const events: UnifiedEvent[] = []
    let resume: SplitResult[] | undefined
    while (true) {
      const { value, done } = await gen.next(resume)
      resume = undefined
      if (done) break
      events.push(value)
      if (value.type === 'gate') resume = [{ splitId: 'sp1', childTaskId: 'c1', outcome: 'done', summary: 'child ok', notes: [] }]
    }
    // must NOT die with provider_error (the bug: the batched signal's tool_use went unanswered,
    // so the next generateText call would be rejected for a missing tool result)
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')
    expect(unansweredToolCallIds(model.doGenerateCalls[1]!.prompt)).toEqual([])
  })

  it('a valid signal batched with an invalid join_splits input also answers every tool_use id', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'sig1', toolName: 'signal', input: { outcome: 'success', summary: 'premature' } },
        { toolCallId: 'j1', toolName: 'join_splits', input: { splitIds: 'not-an-array' } }, // invalid
      ] },
      { toolCalls: [{ toolCallId: 'sig2', toolName: 'signal', input: { outcome: 'success', summary: 'ok now' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')
    expect(unansweredToolCallIds(model.doGenerateCalls[1]!.prompt)).toEqual([])
  })
})
