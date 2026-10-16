import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Checkpoint, EventDraft, ExecutorContext, KnowledgeClaim, OperationCheckpoint, OperationSpec, PreloadedClaim, ResolvedTool, SplitResult, UnifiedEvent } from '@orc/contracts'
import { ClaimClass, ClaimState, Door, EVENT_KIND, FailureClass, OperationKind, PreloadArm, RunOutcome, SignalOutcome, isTerminalError, preloadLine } from '@orc/contracts'
import { stepFixture, must } from '@orc/contracts/fixtures'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { CANCELLED_WHILE_RATE_LIMITED, CANCEL_POLL_MS, PRELOAD_ARM_HEADING, PRELOAD_HEADING, TURN_ECONOMY, apiLoopExecutor, renderKnownContext } from './loop'
import { FIRST_WAIT_MS, TOTAL_WAIT_BUDGET_MS } from './rate-limit'
import { TOOL_NAME, executeTool, releaseWriteClaims } from './tools'

const tempDirs: string[] = []
function tempWorkspace(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

// test-double checkpoint: runs fn, captures drafted events (what DBOS would append durably).
function makeCheckpoint(captured: EventDraft[]): Checkpoint {
  const seen = new Map<string, string>()
  return async (name, fn, toEvents) => {
    const r = await fn()
    if (toEvents) {
      const drafts = toEvents(r)
      drafts.forEach((d, i) => {
        const key = d.idempotencyKey ?? `${name}:${i}:${d.kind}`
        const payload = JSON.stringify(d.payload)
        const prior = seen.get(key)
        if (prior !== undefined && prior !== payload) throw new Error(`idempotency key '${key}' reused with different event data`)
        seen.set(key, payload)
      })
      captured.push(...drafts)
    }
    return r
  }
}

// test-double operation journal: same capture shape, keyed by spec instead of name
function makeOperation(captured: EventDraft[], specs: OperationSpec[] = []): OperationCheckpoint {
  return async (spec, fn, toEvents) => {
    specs.push(spec)
    const r = await fn(1)
    if (toEvents) captured.push(...toEvents(r))
    return r
  }
}

function retryOnceOperation(captured: EventDraft[]): OperationCheckpoint {
  return async (_spec, fn, toEvents) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fn(attempt)
        if (toEvents) captured.push(...toEvents(r))
        return r
      } catch (err) {
        if (isTerminalError(err) || attempt >= 2) throw err
      }
    }
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
    // a step runs inside its run's chat, driven by the supervisor
    origin: { chatId: 'run:t1:v1', door: Door.supervisor },
    workspaceDir: tempWorkspace('orc-ws-'),
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

// Named wire-shape subsets this suite pins, parsed at each read boundary instead of cast.
// Prompt messages carry an array of parts here; a bare-string body simply yields no parts.
const PromptPart = z.object({ type: z.string(), toolCallId: z.string().optional() })
const PromptMessages = z.array(z.object({ content: z.array(PromptPart).optional().catch(undefined) }))
// agent_call payload → the provider request's message array (role + opaque content)
const AgentRequestMessage = z.object({ role: z.string(), content: z.unknown() })
const AgentCallRequest = z.object({ request: z.object({ messages: z.array(AgentRequestMessage) }) })
// agent_call payload → just its request blob (stringified in budget-note assertions)
const RequestPayload = z.object({ request: z.unknown() })
// the recovery tool-result parts a malformed signal produces
const ToolResultParts = z.array(z.object({ toolCallId: z.string(), output: z.object({ value: z.object({ error: z.string() }) }) }))
// an extra tool's echo input
const HelloToolInput = z.object({ who: z.string().optional() })

// A real provider 400s a generateText call if any prior assistant tool-call id lacks a
// matching tool-result — every id that appears as a 'tool-call' part must also appear as a
// 'tool-result' part somewhere in the prompt built so far.
function unansweredToolCallIds(prompt: unknown): string[] {
  const messages = PromptMessages.parse(prompt)
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
import { isRecord } from '@orc/contracts'
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

  // The signal self-report is gone: knowledge tools + knowledge_write's own why are the record now,
  // so a signal carrying a stray `knowledge` field must not leak it into the signal_received draft.
  it('a signal carrying knowledge input records a signal_received payload with no knowledge key', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 's', knowledge: { useful: ['a'], deadEnd: [] } } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    const draft = captured.find(d => d.kind === EVENT_KIND.signal_received)
    const signal = z.object({ signal: z.record(z.string(), z.unknown()) }).parse(draft?.payload).signal
    expect('knowledge' in signal).toBe(false)
  })

  // The continuation seam: a partial signal ends the round like any other (the port owns the
  // grant), and a continuation ctx renders the previous round's summary into the first prompt —
  // it is the ONLY context that survives a round boundary.
  it('a partial signal ends the round as a signal, not an error', async () => {
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.partial, summary: 'done 3/9, remaining: x y z' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, [])))
    expect(events.map(e => e.type)).toEqual(['usage', 'signal', 'done'])
    const signalled = events.find(e => e.type === 'signal')
    expect(signalled && 'signal' in signalled ? signalled.signal.outcome : undefined).toBe(SignalOutcome.partial)
  })

  it('a continuation ctx renders the previous summary into the first prompt', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'finished' } }] },
    ])
    const base = ctx(model, captured)
    await drain(apiLoopExecutor().startTurn({ ...base, continuation: { round: 1, summary: 'healed 14 of 26; remaining ids: a, b' } }))
    const call = captured.find(d => d.kind === EVENT_KIND.agent_call)
    const prompt = JSON.stringify(RequestPayload.parse(call?.payload).request)
    expect(prompt).toContain('Continuing your own previous work (round 2)')
    expect(prompt).toContain('healed 14 of 26; remaining ids: a, b')
  })

  it('a continuation round renders the continuation block and no prior-failure heading', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'finished' } }] },
    ])
    await drain(apiLoopExecutor().startTurn({ ...ctx(model, captured), continuation: { round: 1, summary: 'half done' } }))
    const call = captured.find(d => d.kind === EVENT_KIND.agent_call)
    const prompt = JSON.stringify(RequestPayload.parse(call?.payload).request)
    expect(prompt).toContain('Continuing your own previous work')
    expect(prompt).not.toContain('Your previous attempt failed')
  })

  it('a retried step renders its previous failure whole in the first prompt; a first attempt renders nothing', async () => {
    const heading = '# Your previous attempt failed (attempt 1, agent_error)'
    const message = 'boom: the zone refused src/x.ts'
    const firstPrompt = async (over: Partial<ExecutorContext<LanguageModel>>): Promise<string> => {
      const captured: EventDraft[] = []
      const model = scriptModel([
        { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'finished' } }] },
      ])
      await drain(apiLoopExecutor().startTurn({ ...ctx(model, captured), ...over }))
      const call = captured.find(d => d.kind === EVENT_KIND.agent_call)
      return JSON.stringify(RequestPayload.parse(call?.payload).request)
    }
    const retried = await firstPrompt({ priorFailure: { attempt: 1, class: FailureClass.agent_error, message } })
    expect(retried).toContain(heading)
    expect(retried).toContain(message)
    expect(await firstPrompt({})).not.toContain('Your previous attempt failed')
  })

  // The final-iteration trap, measured live (continuation smoke, both attempts): told "call
  // signal THIS turn" while still offered fs_read, the model spent its last call finishing work
  // and no turn remained to signal from. The final iteration therefore advertises ONLY signal —
  // the report becomes the last turn's single legal move.
  it('the final iteration offers only the signal tool', async () => {
    const seenTools: string[][] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.fs_read, input: { path: 'a.txt' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: TOOL_NAME.fs_read, input: { path: 'b.txt' } }] },
      { toolCalls: [{ toolCallId: 'c3', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.partial, summary: 'read 2, more remain' } }] },
    ], seenTools)
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, []))) // maxIterations: 3
    expect(events.at(-1)?.type).toBe('done')
    expect(seenTools).toHaveLength(3)
    expect(seenTools[0]).toContain(TOOL_NAME.fs_read) // ordinary iterations keep the full set
    expect(seenTools[2]).toEqual([TOOL_NAME.signal]) // the last turn can only report
  })

  it('a 429 is waited out and the model call re-issued — the step completes', async () => {
    const rateLimit = (): unknown => Object.assign(new Error('This request would exceed your account rate limit'), { statusCode: 429 })
    const seenTools: string[][] = []
    const specs: OperationSpec[] = []
    const captured: EventDraft[] = []
    const model = scriptModel([
      { throws: rateLimit() },
      { throws: rateLimit() },
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'survived the rate limit' } }] },
    ], seenTools)
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => { waits.push(ms) }
    const events = await drain(apiLoopExecutor(sleep).startTurn(ctx(model, captured, { operation: makeOperation(captured, specs) })))

    expect(events.map(e => e.type)).toEqual(['usage', 'signal', 'done'])
    expect(seenTools).toHaveLength(3)
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(FIRST_WAIT_MS + FIRST_WAIT_MS * 2)
    expect(Math.max(...waits)).toBeLessThanOrEqual(CANCEL_POLL_MS)
    expect(specs.filter(s => s.kind === OperationKind.model).map(s => s.operationId)).toEqual(['step:t1:s1:a1:model:1'])

    const RateLimitWait = z.object({ waitMs: z.number(), waitsSoFar: z.number(), errorMessage: z.string() })
    const waitDrafts = captured.filter(d => d.kind === EVENT_KIND.rate_limit_wait).map(d => RateLimitWait.parse(d.payload))
    expect(waitDrafts.map(d => d.waitsSoFar)).toEqual([0, 1])
    expect(waitDrafts.map(d => d.waitMs)).toEqual([FIRST_WAIT_MS, FIRST_WAIT_MS * 2])
  })

  it('a single rate-limit wait drafts exactly one rate_limit_wait event, before the successful agent_call', async () => {
    const rateLimit = (): unknown => Object.assign(new Error('This request would exceed your account rate limit'), { statusCode: 429 })
    const captured: EventDraft[] = []
    const model = scriptModel([
      { throws: rateLimit() },
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'survived the rate limit' } }] },
    ])
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => { waits.push(ms) }
    await drain(apiLoopExecutor(sleep).startTurn(ctx(model, captured)))

    const kinds = captured.map(d => d.kind)
    const waitDrafts = captured.filter(d => d.kind === EVENT_KIND.rate_limit_wait)
    expect(waitDrafts).toHaveLength(1)
    const payload = z.object({ stepId: z.string(), runToken: z.string(), waitMs: z.number(), waitsSoFar: z.number(), errorMessage: z.string() }).parse(waitDrafts[0]?.payload)
    expect(payload.waitMs).toBe(FIRST_WAIT_MS)
    expect(payload.waitsSoFar).toBe(0)
    expect(payload.errorMessage).toContain('rate limit')
    expect(kinds.indexOf(EVENT_KIND.rate_limit_wait)).toBeLessThan(kinds.indexOf(EVENT_KIND.agent_call))
  })

  it('a retried operation attempt drafts its own rate_limit_wait — no idempotency collision with the first attempt', async () => {
    const rateLimit = (msg: string): unknown => Object.assign(new Error(msg), { statusCode: 429 })
    const transient = (): unknown => Object.assign(new Error('upstream hiccup'), { statusCode: 502 })
    const captured: EventDraft[] = []
    const model = scriptModel([
      { throws: rateLimit('rate limit A') },
      { throws: transient() }, // non-429, non-terminal: propagates out of attempt 1, forcing a retry
      { throws: rateLimit('rate limit B') },
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'survived two attempts' } }] },
    ])
    const sleep = async (): Promise<void> => {}
    const events = await drain(apiLoopExecutor(sleep).startTurn(ctx(model, captured, { operation: retryOnceOperation(captured) })))

    expect(events.at(-1)?.type).toBe('done')
    const RateLimitWait = z.object({ errorMessage: z.string() })
    const messages = captured.filter(d => d.kind === EVENT_KIND.rate_limit_wait).map(d => RateLimitWait.parse(d.payload).errorMessage)
    expect(messages).toEqual(['rate limit A', 'rate limit B'])
  })

  // The rate_limit_wait checkpoint is nested inside the model operation, where DBOS.runStep
  // degrades to a plain call — so a throw from that purely observational write must not fail the
  // model call it merely records. Measured: without the fix, this checkpoint's throw propagated
  // out of ctx.operation and the step ended in 'error' instead of re-issuing the call.
  it('a rate_limit_wait checkpoint failure does not fail the model call — the wait is best-effort', async () => {
    const rateLimit = (): unknown => Object.assign(new Error('rate limited'), { statusCode: 429 })
    const captured: EventDraft[] = []
    const model = scriptModel([
      { throws: rateLimit() },
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'survived a throwing wait checkpoint' } }] },
    ])
    const sleep = async (): Promise<void> => {}
    const throwingCheckpoint: Checkpoint = async (name, fn, toEvents) => {
      if (name.startsWith('rate-limit-wait:')) throw new Error('ledger write blip')
      const r = await fn()
      if (toEvents) captured.push(...toEvents(r))
      return r
    }
    const events = await drain(apiLoopExecutor(sleep).startTurn(ctx(model, captured, { checkpoint: throwingCheckpoint })))

    expect(events.at(-1)?.type).toBe('done')
    expect(captured.filter(d => d.kind === EVENT_KIND.rate_limit_wait)).toHaveLength(0)
  })

  it('a rate limit that outlasts the wait budget fails the step with a terminal error, after ONE budget', async () => {
    const rateLimit = (): unknown => Object.assign(new Error('still rate limited'), { statusCode: 429 })
    const seenTools: string[][] = []
    const captured: EventDraft[] = []
    const model = scriptModel(Array.from({ length: 20 }, () => ({ throws: rateLimit() })), seenTools)
    let waited = 0
    const sleep = async (ms: number): Promise<void> => { waited += ms }
    const thrown: unknown[] = []
    const operation: ExecutorContext<LanguageModel>['operation'] = async (_spec, fn) => {
      try { return await fn(1) } catch (err) { thrown.push(err); throw err }
    }
    const events = await drain(apiLoopExecutor(sleep).startTurn(ctx(model, captured, { operation })))

    expect(events.at(-1)?.type).toBe('error')
    expect(waited).toBeLessThanOrEqual(TOTAL_WAIT_BUDGET_MS)
    expect(thrown).toHaveLength(1)
    expect(isTerminalError(thrown[0])).toBe(true)
  })

  it('a run cancelled during a rate-limit wait stops waiting and never re-issues the model call', async () => {
    const rateLimit = (): unknown => Object.assign(new Error('rate limited'), { statusCode: 429 })
    const seenTools: string[][] = []
    const captured: EventDraft[] = []
    const model = scriptModel([
      { throws: rateLimit() },
      { toolCalls: [{ toolCallId: 'c1', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'must not be reached' } }] },
    ], seenTools)
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => { waits.push(ms) }
    const isCancelled = async (): Promise<boolean> => waits.length >= 1
    const events = await drain(apiLoopExecutor(sleep).startTurn(ctx(model, captured, { isCancelled })))

    expect(seenTools).toHaveLength(1)
    expect(waits).toEqual([CANCEL_POLL_MS])
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.type === 'error' ? last.message : '').toContain(CANCELLED_WHILE_RATE_LIMITED)
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

  it('two tool calls in ONE turn both execute and both results reach the next request, for one model call', async () => {
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'c1', toolName: TOOL_NAME.fs_write, input: { path: 'a.txt', content: 'a' } },
        { toolCallId: 'c2', toolName: TOOL_NAME.fs_write, input: { path: 'b.txt', content: 'b' } },
      ] },
      { toolCalls: [{ toolCallId: 'c3', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'ok' } }] },
    ])
    const c = ctx(model, captured, { operation: makeOperation(captured, specs), step: stepFixture({ instructions: 'do the thing', maxIterations: 10 }) })
    await drain(apiLoopExecutor().startTurn(c))

    expect(readFileSync(path.join(c.workspaceDir, 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(path.join(c.workspaceDir, 'b.txt'), 'utf8')).toBe('b')
    expect(specs.filter(s => s.kind === OperationKind.model).map(s => s.operationId))
      .toEqual(['step:t1:s1:a1:model:1', 'step:t1:s1:a1:model:2'])
    const agentCalls = captured.filter(d => d.kind === EVENT_KIND.agent_call)
    const second = AgentCallRequest.parse(must(agentCalls[1], 'agentCalls[1]').payload).request.messages
    const answered = second.flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter((p): p is { type: string; toolCallId: string } => isRecord(p) && p.type === 'tool-result' && typeof p.toolCallId === 'string')
      .map(p => p.toolCallId)
    expect(answered).toEqual(['c1', 'c2'])
  })

  it('the turn-economy rule is sent once, in the stable prefix, never per iteration', async () => {
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'fs_write', input: { path: 'out.txt', content: 'hi' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: TOOL_NAME.signal, input: { outcome: SignalOutcome.success, summary: 'ok' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, { operation: makeOperation(captured, specs) })))
    const modelCalls = specs.filter(sp => sp.kind === OperationKind.model)
    expect(modelCalls).toHaveLength(2)
    expect(JSON.stringify(must(modelCalls[0], 'first model call').before)).toContain(TURN_ECONOMY)
    expect(JSON.stringify(must(modelCalls[1], 'second model call').before)).not.toContain(TURN_ECONOMY)
  })

  it('a repeated tool_use id is dropped from the REPLAYED assistant message, not just from execution', async () => {
    // Killed a real step: the model repeated a tool_use id in one turn, uniqueByCallId deduped our
    // execution (one tool_call + one tool_result in the log, clean journal) but the raw assistant
    // message replayed BOTH tool_use blocks, so the next request died on `each tool_use must have a
    // single result`. Both views must be deduped at the same boundary.
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const model = scriptModel([
      { toolCalls: [
        { toolCallId: 'dup', toolName: 'fs_write', input: { path: 'a.txt', content: '1' } },
        { toolCallId: 'dup', toolName: 'fs_write', input: { path: 'a.txt', content: '2' } },
      ] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, { operation: makeOperation(captured, specs) })))
    // executed once (the existing guarantee)
    expect(captured.filter(d => d.kind === EVENT_KIND.tool_result)).toHaveLength(1)
    // and the replayed history carries that id exactly twice — one tool-call part, one
    // tool-result part. Three (two calls, one result) is the shape the provider rejects.
    const prompts = specs.filter(sp => sp.kind === OperationKind.model).map(sp => JSON.stringify(sp.before))
    const occurrences = (prompts[1] ?? '').split('"toolCallId":"dup"').length - 1
    expect(occurrences).toBe(2)
  })

  it('zone write-fence holds at the loop seam: a write outside step.zone is refused, inside succeeds', async () => {
    // pins the ONE seam that connects the fence — loop.ts passing `zone: ctx.step.zone` to executeTool.
    // Every other link (assertInZone, executeTool, plan-note zone) is tested in isolation, so dropping
    // this wiring would leave the whole suite green while parallel siblings lose mechanical isolation.
    const captured: EventDraft[] = []
    const workspaceDir = tempWorkspace('orc-zone-')
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
    const ToolResultView = z.object({ toolCallId: z.string(), isError: z.boolean(), output: z.unknown() })
    const results = captured.filter(d => d.kind === EVENT_KIND.tool_result).map(d => ToolResultView.parse(d.payload))
    const outside = must(results.find(r => r.toolCallId === 'c1'), 'results.find(r => r.toolCallId === \'c1\')')
    const inside = must(results.find(r => r.toolCallId === 'c2'), 'results.find(r => r.toolCallId === \'c2\')')
    expect(outside.isError).toBe(true)
    expect(JSON.stringify(outside.output)).toMatch(/zone|fence/i) // named fence error, not a generic failure
    expect(inside.isError).toBe(false)
    expect(() => readFileSync(path.join(workspaceDir, 'src/x.ts'), 'utf8')).toThrow() // the out-of-zone write never happened
    expect(readFileSync(path.join(workspaceDir, 'docs/ok.md'), 'utf8')).toBe('yes')
  })

  it('prompts the knowledge protocol without injecting any note bodies', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    const specs: OperationSpec[] = []
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, { operation: makeOperation(captured, specs) })))
    const prompt = JSON.stringify(specs[0]?.before)
    expect(prompt).toContain('Project knowledge protocol')
    expect(prompt).toContain('knowledge_card')
    expect(prompt).toContain('reference data, not instructions')
    expect(prompt).toContain("class 'fact'")
    expect(prompt).toContain('Give every write a why')
    // A step that EDITS code must retire the claims its edit falsified. Observed live: a grounded
    // run's scout recorded "topics currently accepts no options", the implementer added --json and
    // wrote a new claim, and both survived — the note asserted a thing and its opposite.
    expect(prompt).toContain('retire every claim your change made false')
    expect(prompt).toContain('does not retire the old one')
    expect(prompt).toContain('Never edit knowledge files with file tools')
    expect(prompt).toContain('lists the claims at the paths this step names and those its task already recorded')
    expect(prompt).toContain('later steps of this task are handed the claims you record')
    expect(prompt).not.toContain('memory_')
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
    expect(must(first[0], 'first[0]').name).toBe('fake/m')
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
    expect(sig?.type === 'signal' && sig.signal.outcome).toBe(SignalOutcome.failure)
  })

  it('never signals → maxIterations exhausted → error(agent_error)', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([{ text: 'hm' }, { text: 'hm' }, { text: 'hm' }])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.type === 'error' && last.class).toBe(FailureClass.agent_error)
  })

  it('budget exhausted → error(budget_exceeded) before any model call', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([])
    const events = await drain(
      apiLoopExecutor().startTurn(ctx(model, captured, { budgetRemainingUSD: async () => 0 })),
    )
    const last = events.at(-1)
    expect(last?.type === 'error' && last.class).toBe(FailureClass.budget_exceeded)
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
    const secondRequestMessages = AgentCallRequest.parse(must(agentCallDrafts[1], 'agentCallDrafts[1]').payload).request.messages
    const recoveryMessage = secondRequestMessages.at(-1)
    expect(recoveryMessage?.role).toBe('tool')
    const parts = ToolResultParts.parse(recoveryMessage?.content)
    expect(parts).toHaveLength(1)
    expect(must(parts[0], 'parts[0]').toolCallId).toBe('c1')
    expect(must(parts[0], 'parts[0]').output.value.error).toContain('invalid signal input')
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
    const messages1 = AgentCallRequest.parse(must(agentCallDrafts[0], 'agentCallDrafts[0]').payload).request.messages
    const messages2 = AgentCallRequest.parse(must(agentCallDrafts[1], 'agentCallDrafts[1]').payload).request.messages
    expect(messages1).toHaveLength(1) // the initial user prompt
    expect(messages2).toHaveLength(2) // ONLY what was appended since: assistant (tool call) + tool result
    // concatenated deltas reconstruct the full request history without O(n²) storage
    expect([...messages1, ...messages2].map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
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
    const firstRequestMessages = AgentCallRequest.parse(must(agentCallDrafts[0], 'agentCallDrafts[0]').payload).request.messages
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
      execute: async (input, toolCallId) => { seenToolCallId = toolCallId; return { output: { hi: HelloToolInput.parse(input).who }, isError: false } },
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
    // kernel/task_split derive a deterministic, non-colliding split id
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
        resume = [{ splitId: 'sp1', childTaskId: 'c1', outcome: RunOutcome.done, summary: 'child ok', claims: [{ id: 'n1', location: 'k/n1.md' }] }]
      }
    }
    expect(events.some(e => e.type === 'gate')).toBe(true)
    const result = events.find(e => e.type === 'tool_result' && e.toolCallId === 'j1')
    expect(result?.type === 'tool_result' && !result.isError).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
    // the model's second turn saw the split results in its tool message
    expect(JSON.stringify(must(model.doGenerateCalls[1], 'model.doGenerateCalls[1]').prompt)).toContain('child ok')
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
      if (value.type === 'gate') resume = [{ splitId: 'sp1', childTaskId: 'c1', outcome: RunOutcome.done, summary: 'child ok', claims: [] }]
    }
    // must NOT die with provider_error (the bug: the batched signal's tool_use went unanswered,
    // so the next generateText call would be rejected for a missing tool result)
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')
    expect(unansweredToolCallIds(must(model.doGenerateCalls[1], 'model.doGenerateCalls[1]').prompt)).toEqual([])
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
    expect(unansweredToolCallIds(must(model.doGenerateCalls[1], 'model.doGenerateCalls[1]').prompt)).toEqual([])
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
    expect(JSON.stringify(must(model.doGenerateCalls[1], 'model.doGenerateCalls[1]').prompt)).toContain('yes, approve')
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
    expect(unansweredToolCallIds(must(model.doGenerateCalls[1], 'model.doGenerateCalls[1]').prompt)).toEqual([])
  })
})

describe('iteration-budget awareness', () => {
  it('announces the budget up front and warns durably in the final 3 iterations', async () => {
    const captured: EventDraft[] = []
    // 3 tool-less turns, maxIterations 3 -> every iteration is in the endgame window
    const events = await drain(apiLoopExecutor().startTurn(ctx(scriptModel([{}, {}, {}]), captured)))

    const requests = captured
      .filter(e => e.kind === EVENT_KIND.agent_call)
      .map(e => JSON.stringify(RequestPayload.parse(e.payload).request))
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
    const first = JSON.stringify(RequestPayload.parse(must(captured.find(e => e.kind === EVENT_KIND.agent_call), 'captured.find(e => e.kind === EVENT_KIND.agent_call)').payload).request)
    expect(first).toContain('Iteration budget: 10 model calls')
    expect(first).not.toContain('model calls left')
    expect(first).not.toContain('FINAL iteration')
  })
})

describe('memory lint nudge', () => {
  it('a memory_write lint warning nudges the very next iteration only, not the one after', async () => {
    const captured: EventDraft[] = []
    const memoryWrite: ResolvedTool = {
      ref: 'memory/write',
      name: 'memory_write',
      description: 'fake memory_write',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ output: { id: 'x', warnings: ['body is 1840 chars — …'] }, isError: false }),
    }
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'memory_write', input: { id: 'x', title: 'X' } }] },
      { text: 'thinking' }, // no tool calls -> generic 'Continue' nudge, no memory lint to report
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'done' } }] },
    ])
    // maxIterations 10: outside the endgame-budget window — the fixture default of 3 would mask gating bugs
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured, {
      extraTools: [memoryWrite],
      step: stepFixture({ instructions: 'do the thing', maxIterations: 10 }),
    })))
    expect(events.at(-1)?.type).toBe('done')

    const agentCallDrafts = captured.filter(d => d.kind === EVENT_KIND.agent_call)
    expect(agentCallDrafts).toHaveLength(3)
    const secondRequest = JSON.stringify(AgentCallRequest.parse(must(agentCallDrafts[1], 'agentCallDrafts[1]').payload).request.messages)
    expect(secondRequest).toContain(`memory lint on 'x'`)
    expect(secondRequest).toContain('not optional')
    // fires once: the third iteration's delta must not repeat the nudge
    const thirdRequest = JSON.stringify(AgentCallRequest.parse(must(agentCallDrafts[2], 'agentCallDrafts[2]').payload).request.messages)
    expect(thirdRequest).not.toContain('memory lint')
  })
})

describe('step knowledge seam', () => {
  const signalled = (outcome: 'success' | 'failure', summary: string) =>
    scriptModel([{ toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome, summary } }] }])

  // The mechanical half of knowledge-protocol rule 7. The prompt rule alone failed live: a run
  // added a CLI flag while the claim saying that command "accepts no options" stayed live, so one
  // note asserted a thing and its opposite. The executor finds the candidates deterministically;
  // deciding which are now FALSE stays the model's job.
  const atRiskClaim: KnowledgeClaim = {
    id: 'aaaaaaaa', text: 'orc memory topics accepts no options.', class: ClaimClass.fact,
    anchors: [{ path: 'main.ts', symbol: null }], tags: [], sources: [], decision: null, location: 'knowledge/main.ts.md',
  }
  const fakeKnowledge = (claims: KnowledgeClaim[] = [], preloaded: PreloadedClaim[] = []) => {
    const citedPaths: string[][] = []
    const budgets: number[] = []
    const rounds: number[] = []
    return {
      citedPaths, budgets, rounds,
      knowledge: {
        claimsAt: async (paths: readonly string[]) => { citedPaths.push([...paths]); return claims },
        preload: async (budget: number, round: number) => { budgets.push(budget); rounds.push(round); return preloaded },
      },
    }
  }
  const known = (id: string, text: string, state: ClaimState, arm: PreloadArm, anchors: KnowledgeClaim['anchors'] = [{ path: 'src/a.ts', symbol: null }]): PreloadedClaim => ({
    claim: { id, text, class: ClaimClass.fact, anchors, tags: [], sources: [], decision: null, location: 'src/knowledge/a.ts.md' }, state, arm,
  })
  const firstPrompt = (specs: OperationSpec[]): string => {
    const before = z.object({ messages: z.array(z.object({ content: z.string() })) }).parse(specs[0]?.before)
    return before.messages[0]?.content ?? ''
  }

  it('surfaces claims citing a file the step EDITED, once, and only after a successful write', async () => {
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const { citedPaths, knowledge } = fakeKnowledge([atRiskClaim])
    // turn 1 edits a file; turn 2 must carry the at-risk block; turn 3 signals. A second edit of the
    // SAME path must not re-surface it — a block repeated every turn is one the model learns to skip.
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'fs_write', input: { path: 'main.ts', content: 'x' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'fs_write', input: { path: 'main.ts', content: 'y' } }] },
      { toolCalls: [{ toolCallId: 'c3', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, {
      knowledge, operation: makeOperation(captured, specs),
    })))
    expect(citedPaths).toEqual([['main.ts']]) // asked once, for the path actually written
    // specs interleaves model and tool operations — the prompts are the model ones
    const prompts = specs.filter(sp => sp.kind === OperationKind.model).map(sp => JSON.stringify(sp.before))
    const second = prompts[1] ?? ''
    expect(second).toContain('You edited main.ts')
    expect(second).toContain('- [aaaaaaaa] fact: orc memory topics accepts no options.')
    expect(second).toContain('knowledge_write')
    expect(second).toContain('Leave the ones still true alone')
    expect(second).not.toContain('invalidates')
    // and NOT repeated after the second edit of the same file
    expect(prompts[2] ?? '').not.toContain('You edited main.ts')
  })

  it('says nothing when a read-only step touches no file', async () => {
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const { citedPaths, knowledge } = fakeKnowledge([atRiskClaim])
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'fs_read', input: { path: 'main.ts' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'ok' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, {
      knowledge, operation: makeOperation(captured, specs),
    })))
    // reading a file cannot falsify a claim about it — no query, no block
    expect(citedPaths).toEqual([])
    const prompts = specs.filter(sp => sp.kind === OperationKind.model).map(sp => JSON.stringify(sp.before))
    expect(prompts[1] ?? '').not.toContain('You edited main.ts')
  })

  it('renders each arm under its heading, marks a claim that is not clean, and counts the delivered states', async () => {
    const captured: EventDraft[] = []
    const specs: OperationSpec[] = []
    const { budgets, knowledge } = fakeKnowledge([], [
      known('pushed01', 'The step before wrote this.', ClaimState.clean, PreloadArm.pushed),
      known('hereaaaa', 'Config is parsed once.', ClaimState.clean, PreloadArm.here, [{ path: 'src/a.ts', symbol: 'load' }, { path: 'src/b.ts', symbol: null }]),
      known('heresusp', 'The cache is never cleared.', ClaimState.suspect, PreloadArm.here),
      known('relatedx', 'Nothing anchors this.', ClaimState.unanchored, PreloadArm.search, []),
    ])
    await drain(apiLoopExecutor().startTurn(ctx(signalled('success', 'ok'), captured, {
      knowledge, knowledgePreloadTokens: 1_200, operation: makeOperation(captured, specs),
    })))
    expect(budgets).toEqual([1_200])
    const prompt = firstPrompt(specs)
    const block = prompt.slice(prompt.indexOf(PRELOAD_HEADING), prompt.indexOf('# Project knowledge protocol')).trim().split('\n')
    expect(block[0]).toBe(PRELOAD_HEADING)
    for (const rule of ['clean: unchanged since it was written or checked — rely on it', 're-read the anchor first', 'unknown: could not be compared']) expect(block[1]).toContain(rule)
    for (const state of Object.values(ClaimState)) expect(block[1]).toContain(`${state}: `)
    expect(block.slice(2)).toEqual([
      'Currency: 2 clean, 1 unanchored, 1 suspect',
      `## ${PRELOAD_ARM_HEADING[PreloadArm.pushed]}`,
      '- The step before wrote this. {pushed01 @src/a.ts}',
      `## ${PRELOAD_ARM_HEADING[PreloadArm.here]}`,
      '- Config is parsed once. {hereaaaa @src/a.ts#load @src/b.ts}',
      '- The cache is never cleared. {heresusp suspect @src/a.ts}',
      `## ${PRELOAD_ARM_HEADING[PreloadArm.search]}`,
      '- Nothing anchors this. {relatedx unanchored}',
    ])
    expect(prompt).not.toContain(PRELOAD_ARM_HEADING[PreloadArm.around])
  })

  it('renders a claim as the one preload line the port costs, clean and suspect alike', () => {
    const clean = known('cleanaaa', 'Clean claim.', ClaimState.clean, PreloadArm.here)
    const suspect = known('suspectb', 'Suspect claim.', ClaimState.suspect, PreloadArm.here, [{ path: 'src/a.ts', symbol: 'run' }])
    expect(renderKnownContext([clean, suspect]).split('\n').slice(-2)).toEqual([preloadLine(clean.claim, clean.state), preloadLine(suspect.claim, suspect.state)])
  })

  it('no block when the preload delivers nothing, or the budget is zero or unset', async () => {
    const one = [known('aaaaaaaa', 'x', ClaimState.clean, PreloadArm.here)]
    const cases: Array<{ over: Partial<ExecutorContext<LanguageModel>>; delivered: PreloadedClaim[]; asked: number[] }> = [
      { over: { knowledgePreloadTokens: 1_200 }, delivered: [], asked: [1_200] },
      { over: { knowledgePreloadTokens: 0 }, delivered: one, asked: [] },
      { over: {}, delivered: one, asked: [] },
    ]
    for (const { over, delivered, asked } of cases) {
      const captured: EventDraft[] = []
      const specs: OperationSpec[] = []
      const { budgets, knowledge } = fakeKnowledge([], delivered)
      await drain(apiLoopExecutor().startTurn(ctx(signalled('success', 'ok'), captured, { knowledge, ...over, operation: makeOperation(captured, specs) })))
      expect(firstPrompt(specs)).not.toContain(PRELOAD_HEADING)
      expect(budgets).toEqual(asked)
    }
  })

  it('hands the preload the continuation round it runs in, round 0 first', async () => {
    for (const { over, round } of [{ over: {}, round: 0 }, { over: { continuation: { round: 2, summary: 'half done' } }, round: 2 }]) {
      const captured: EventDraft[] = []
      const { rounds, knowledge } = fakeKnowledge()
      await drain(apiLoopExecutor().startTurn(ctx(signalled('success', 'ok'), captured, { knowledge, knowledgePreloadTokens: 1_200, ...over })))
      expect(rounds).toEqual([round])
    }
  })

  it('a replay rebuilds the block from the recorded preload without asking again', async () => {
    const recorded = new Map<string, string>()
    const replaying: Checkpoint = async (name, fn) => {
      const held = recorded.get(name)
      if (held !== undefined) return JSON.parse(held)
      const r = await fn()
      recorded.set(name, JSON.stringify(r))
      return r
    }
    const run = async (preloaded: PreloadedClaim[]) => {
      const captured: EventDraft[] = []
      const specs: OperationSpec[] = []
      const fake = fakeKnowledge([], preloaded)
      await drain(apiLoopExecutor().startTurn(ctx(signalled('success', 'ok'), captured, {
        knowledge: fake.knowledge, knowledgePreloadTokens: 1_200, checkpoint: replaying, operation: makeOperation(captured, specs),
      })))
      return { prompt: firstPrompt(specs), budgets: fake.budgets }
    }
    const first = await run([known('aaaaaaaa', 'Recorded claim.', ClaimState.clean, PreloadArm.here)])
    const replay = await run([known('bbbbbbbb', 'A live claim the replay must not see.', ClaimState.clean, PreloadArm.here)])
    expect(replay.budgets).toEqual([])
    expect(replay.prompt).toBe(first.prompt)
    expect(replay.prompt).toContain('- Recorded claim. {aaaaaaaa @src/a.ts}')
  })

  // ai@7 answers a schema-invalid tool call itself (parseToolCall catches InvalidToolInputError and
  // writes an error tool-result into responseMessages). Ours must REPLACE it, not sit beside it:
  // two results for one tool_use is the same 400 a duplicate tool_use causes, and the SDK's generic
  // parse error is not something the model can act on.
  it('answers a schema-invalid signal call exactly once, with the actionable error', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'dup', toolName: 'signal', input: { outcome: 'maybe' } }] },
      { toolCalls: [{ toolCallId: 'ok', toolName: 'signal', input: { outcome: 'success', summary: 'done' } }] },
    ])
    await drain(apiLoopExecutor().startTurn(ctx(model, captured, { step: stepFixture({ instructions: 'go', maxIterations: 10 }) })))
    const second = AgentCallRequest.parse(must(captured.filter(d => d.kind === EVENT_KIND.agent_call)[1], 'captured.filter(d => d.kind === EVENT_KIND.agent_call)[1]').payload).request.messages
    const results = second.flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter((p): p is { type: string; toolCallId: string } => isRecord(p) && p.type === 'tool-result' && typeof p.toolCallId === 'string')
    // exactly one result for the id — this is the invariant a real provider enforces with a 400
    expect(results.filter(r => r.toolCallId === 'dup')).toHaveLength(1)
  })

  // A parked turn writes nothing, but it held every path it had written — and the join gate parks
  // waiting on the very children those claims fence out, for up to GATE_POLL_SECONDS (3600) per
  // poll. The child's refusal then reads as a concurrency error nobody caused.
  it('releases its write claims while parked, so a sibling can take the path', async () => {
    const captured: EventDraft[] = []
    const dir = tempWorkspace('orc-park-')
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'w', toolName: 'fs_write', input: { path: 'shared.md', content: 'A' } }] },
      { toolCalls: [{ toolCallId: 'q', toolName: 'ask_human', input: { question: 'proceed?' } }] },
    ])
    const gen = apiLoopExecutor().startTurn(ctx(model, captured, { workspaceDir: dir, runToken: 'step:t:parent:a1' }))[Symbol.asyncIterator]()
    let ev = await gen.next()
    while (!ev.done && ev.value.type !== 'feedback') ev = await gen.next()
    expect(ev.done).toBe(false)

    // suspended on ask_human: a sibling step must be able to write the path the parent wrote
    const sibling = await executeTool(
      TOOL_NAME.fs_write, { path: 'shared.md', content: 'B' }, dir, [], undefined, { writer: 'step:t:child:a1' },
    )
    expect(sibling.isError).toBe(false)
    releaseWriteClaims('step:t:child:a1')
    await gen.return?.(undefined)
  })

  it('no knowledge on the context: the step runs to done', async () => {
    const captured: EventDraft[] = []
    const events = await drain(apiLoopExecutor().startTurn(ctx(signalled('success', 'ok'), captured, {
      knowledgePreloadTokens: 1_200,
    })))
    expect(events.at(-1)?.type).toBe('done')
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

describe('repeated provider tool_call ids', () => {
  // The failure this reproduces: one turn carrying the SAME toolCallId twice made messages.push
  // emit two tool_result blocks for one tool_use, which the API rejects non-retryably
  // ("each tool_use must have a single result") — killing the step and everything gated on it.
  // The journal showed nothing, because the shared operationId memoised the repeat to one row.
  it('answers a repeated call id exactly once', async () => {
    const captured: EventDraft[] = []
    const calls: Array<{ input: unknown; toolCallId: string | undefined }> = []
    const echo: ResolvedTool = {
      ref: 'test/echo', name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} },
      execute: async (input, toolCallId) => { calls.push({ input, toolCallId }); return { output: { ok: true }, isError: false } },
    }
    const dup = { toolCallId: 'toolu_dup', toolName: 'echo', input: { a: 1 } }
    const model = scriptModel([
      { toolCalls: [dup, dup] },                                                     // provider repeats one id
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'done' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured, {
      extraTools: [echo], taskId: 'task-1', step: stepFixture({ id: 's1', title: 'S', instructions: 'do', maxIterations: 3 }),
    })))

    expect(events.at(-1)?.type).toBe('done')                       // the step survives instead of 400-ing
    const results = events.filter(e => e.type === 'tool_result' && 'toolCallId' in e && e.toolCallId === 'toolu_dup')
    expect(results).toHaveLength(1)                                // exactly one result per tool_use id
    expect(calls.filter(c => c.toolCallId === 'toolu_dup')).toHaveLength(1) // and the effect ran once
  })
})
