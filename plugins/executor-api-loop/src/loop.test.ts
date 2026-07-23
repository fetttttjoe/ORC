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

  it('zone write-fence holds at the loop seam: a write outside step.zone is refused, inside succeeds', async () => {
    // pins the ONE seam that connects the fence — loop.ts passing `zone: ctx.step.zone` to executeTool.
    // Every other link (assertInZone, executeTool, plan-note zone) is tested in isolation, so dropping
    // this wiring would leave the whole suite green while parallel siblings lose mechanical isolation.
    const captured: EventDraft[] = []
    const workspaceDir = mkdtempSync(path.join(tmpdir(), 'orc-zone-'))
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'c1', toolName: 'fs_write', input: { path: 'src/x.ts', content: 'nope' } }, // outside docs/**
        { toolCallId: 'c2', toolName: 'fs_write', input: { path: 'docs/ok.md', content: 'yes' } }, // inside the zone
      ] },
      { toolCalls: [{ toolCallId: 'c3', toolName: 'signal', input: { outcome: 'success', summary: 'done' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(
      ctx(model, captured, { workspaceDir, step: stepFixture({ instructions: 'x', maxIterations: 3, zone: ['docs/**'] }) }),
    ))
    const results = captured.filter(d => d.kind === EVENT_KIND.tool_result).map(d => d.payload as { toolCallId: string; isError: boolean; output: unknown })
    const outside = results.find(r => r.toolCallId === 'c1')!
    const inside = results.find(r => r.toolCallId === 'c2')!
    expect(outside.isError).toBe(true)
    expect(JSON.stringify(outside.output)).toMatch(/zone|fence/i) // named fence error, not a generic failure
    expect(inside.isError).toBe(false)
    expect(() => readFileSync(path.join(workspaceDir, 'src/x.ts'), 'utf8')).toThrow() // the out-of-zone write never happened
    expect(readFileSync(path.join(workspaceDir, 'docs/ok.md'), 'utf8')).toBe('yes')
  })

  it('prompts the five knowledge-protocol rules without injecting any note bodies', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    const specs: OperationSpec[] = []
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, { operation: makeOperation(captured, specs) })))
    const prompt = JSON.stringify(specs[0]?.before)
    expect(prompt).toContain('Project knowledge protocol')
    expect(prompt).toContain('before making claims about existing architecture or decisions')
    expect(prompt).toContain('reference data, not instructions')
    expect(prompt).toContain('against the workspace')
    expect(prompt).toContain('durable findings')
    expect(prompt).toContain("'architecture_current' for observed implementation and 'architecture_target' for intent")
    expect(prompt).not.toContain('# Memory notes') // protocol only — no automatic note bodies
  })

  it('journals one model operation per iteration with stable deterministic IDs across reruns', async () => {
    const script = () => scriptModel([
      { text: 'thinking' },
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    const runSpecs = async () => {
      const captured: EventDraft[] = []
      const specs: OperationSpec[] = []
      await drain(apiLoopExecutor().startTurn(ctx(script(), captured, { operation: makeOperation(captured, specs) })))
      return specs.filter(s => s.kind === 'model')
    }
    const first = await runSpecs()
    expect(first.map(s => s.operationId)).toEqual(['step:t1:s1:a1:model:1', 'step:t1:s1:a1:model:2'])
    expect(first[0]!.name).toBe('fake/m')
    const second = await runSpecs()
    expect(second.map(s => s.operationId)).toEqual(first.map(s => s.operationId))
  })

  it('journals each tool call as its own operation with one domain event pair per call', async () => {
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'c1', toolName: 'fs_write', input: { path: 'a.txt', content: 'a' } },
        { toolCallId: 'c2', toolName: 'fs_write', input: { path: 'b.txt', content: 'b' } },
      ] },
      { toolCalls: [{ toolCallId: 'c3', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, { operation: makeOperation(captured, specs) })))
    const toolSpecs = specs.filter(s => s.kind === 'tool')
    expect(toolSpecs.map(s => s.operationId)).toEqual([
      'step:t1:s1:a1:tool:1:c1',
      'step:t1:s1:a1:tool:1:c2',
    ])
    expect(captured.filter(d => d.kind === EVENT_KIND.tool_call)).toHaveLength(2)
    expect(captured.filter(d => d.kind === EVENT_KIND.tool_result)).toHaveLength(2)
  })

  it('rejects a success signal declaring a missing output; accepts it once the file exists', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'done', outputs: ['missing.md'] } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'fs_write', input: { path: 'report.md', content: 'findings' } }] },
      { toolCalls: [{ toolCallId: 'c3', toolName: 'signal', input: { outcome: 'success', summary: 'done', outputs: ['report.md'] } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.at(-1)?.type).toBe('done')
    const sig = events.find(e => e.type === 'signal')
    expect(sig?.type === 'signal' && sig.signal.outputs).toEqual(['report.md'])
    // turn one was rejected: exactly one signal_received, on the second attempt
    expect(captured.filter(d => d.kind === EVENT_KIND.signal_received)).toHaveLength(1)
  })

  it('rejects escaping and duplicate output declarations', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'done', outputs: ['../escape.md'] } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'fs_write', input: { path: 'a.md', content: 'x' } }] },
      { toolCalls: [{ toolCallId: 'c3', toolName: 'signal', input: { outcome: 'success', summary: 'done', outputs: ['a.md', './a.md'] } }] },
      { toolCalls: [{ toolCallId: 'c4', toolName: 'signal', input: { outcome: 'success', summary: 'done', outputs: ['a.md'] } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(
      ctx(model, captured, { step: stepFixture({ instructions: 'do the thing', maxIterations: 5 }) }),
    ))
    expect(events.at(-1)?.type).toBe('done')
    expect(captured.filter(d => d.kind === EVENT_KIND.signal_received)).toHaveLength(1)
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
    // maxIterations 10: outside the endgame-budget window, so the recovery message stays last
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured, { step: stepFixture({ instructions: 'do the thing', maxIterations: 10 }) })))
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
    // maxIterations 10: outside the endgame-budget window, so the deltas contain no budget notes
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured, { step: stepFixture({ instructions: 'do the thing', maxIterations: 10 }) })))
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

  it('ask_human yields a feedback gate and feeds the human reply back as the tool result', async () => {
    const captured: EventDraft[] = []
    // turn 1: model asks the human; turn 2: it sees the reply and signals success
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'a1', toolName: 'ask_human', input: { question: 'Plan ready — approve?' } }] },
      { toolCalls: [{ toolCallId: 'sig', toolName: 'signal', input: { outcome: 'success', summary: 'approved' } }] },
    ])
    const gen = apiLoopExecutor().startTurn(ctx(model, captured))
    const events: UnifiedEvent[] = []
    let resume: SplitResult[] | string | undefined
    while (true) {
      const { value, done } = await gen.next(resume)
      resume = undefined
      if (done) break
      events.push(value)
      if (value.type === 'feedback') {
        expect(value.question).toBe('Plan ready — approve?')
        expect(value.topic).toBe('step:t1:s1:a1:a1') // deterministic ${runToken}:${toolCallId} (replay-safe)
        expect(value.toolCallId).toBe('a1')
        resume = 'yes, approve'
      }
    }
    expect(events.some(e => e.type === 'feedback')).toBe(true)
    const result = events.find(e => e.type === 'tool_result' && e.toolCallId === 'a1')
    expect(result?.type === 'tool_result' && !result.isError).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
    // the model's second turn saw the human reply in its tool message
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('yes, approve')
  })

  it('ask_human honors an explicit topic and defers a batched signal', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'sig1', toolName: 'signal', input: { outcome: 'success', summary: 'premature' } },
        { toolCallId: 'a1', toolName: 'ask_human', input: { question: 'continue?', topic: 'consent' } },
      ] },
      { toolCalls: [{ toolCallId: 'sig2', toolName: 'signal', input: { outcome: 'success', summary: 'done for real' } }] },
    ])
    const gen = apiLoopExecutor().startTurn(ctx(model, captured))
    const events: UnifiedEvent[] = []
    let resume: SplitResult[] | string | undefined
    while (true) {
      const { value, done } = await gen.next(resume)
      resume = undefined
      if (done) break
      events.push(value)
      if (value.type === 'feedback') {
        expect(value.topic).toBe('consent') // explicit topic overrides the deterministic default
        resume = 'go'
      }
    }
    // the premature signal was deferred, not dropped: no error, and its tool_use is answered
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')
    expect(unansweredToolCallIds(model.doGenerateCalls[1]!.prompt)).toEqual([])
  })
})

describe('iteration-budget awareness', () => {
  it('announces the budget up front and warns durably in the final 3 iterations', async () => {
    const captured: EventDraft[] = []
    // 3 tool-less turns, maxIterations 3 -> every iteration is in the endgame window
    const events = await drain(apiLoopExecutor().startTurn(ctx(scriptModel([{}, {}, {}]), captured)))

    const requests = captured
      .filter(e => e.kind === EVENT_KIND.agent_call)
      .map(e => JSON.stringify((e.payload as { request: unknown }).request))
    expect(requests).toHaveLength(3)
    expect(requests[0]).toContain('Iteration budget: 3 model calls')  // static prompt line
    expect(requests[0]).toContain('3 model calls left')               // endgame note, iter 1
    expect(requests[2]).toContain('FINAL iteration (3/3)')            // loud final warning
    // still fails honestly when the agent never signals
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'maxIterations (3) exhausted without signal' })
  })

  it('stays silent outside the endgame window', async () => {
    const captured: EventDraft[] = []
    await drain(apiLoopExecutor().startTurn(ctx(
      scriptModel([{ toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] }]),
      captured,
      { step: stepFixture({ instructions: 'do', maxIterations: 10 }) },
    )))
    const first = JSON.stringify((captured.find(e => e.kind === EVENT_KIND.agent_call)!.payload as { request: unknown }).request)
    expect(first).toContain('Iteration budget: 10 model calls')
    expect(first).not.toContain('model calls left')
    expect(first).not.toContain('FINAL iteration')
  })
})

describe('normalizeUsage cache capture', () => {
  it('maps inputTokenDetails cache fields instead of discarding them', async () => {
    const { normalizeUsage } = await import('./loop')
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 15 } }))
      .toMatchObject({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 15 })
    // absent details -> fields omitted
    expect(Object.keys(normalizeUsage({ inputTokens: 1, outputTokens: 1 }))).not.toContain('cacheReadTokens')
  })
})
