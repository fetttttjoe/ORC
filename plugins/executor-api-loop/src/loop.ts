import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import {
  EVENT_KIND, FAILURE_CLASS, UNIFIED_EVENT_TYPE,
  type AgentExecutor, type EventDraft, type ExecutorContext, type Signal,
  type UnifiedEvent, type Usage,
} from '@orc/contracts'
import { SignalInput, TOOL_NAME, executeTool, toolSet } from './tools'

export class TransientProviderError extends Error {}

interface TurnResult {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  usage: Usage
  responseMessages: ModelMessage[]
}

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

function isTransient(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number }).statusCode
    ?? (err as { status?: number }).status
  if (typeof status === 'number') return TRANSIENT_STATUS.has(status)
  const code = (err as { code?: string }).code
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND'
}

function normalizeUsage(u: { inputTokens?: number; outputTokens?: number } | undefined): Usage {
  const input = u?.inputTokens
  const output = u?.outputTokens
  return {
    inputTokens: Number.isFinite(input) ? (input as number) : 0,
    outputTokens: Number.isFinite(output) ? (output as number) : 0,
    costUSD: null, // priced by the port, which knows the provider cost table
    estimated: !Number.isFinite(input) || !Number.isFinite(output),
  }
}

async function callModel(model: LanguageModel, messages: ModelMessage[]): Promise<TurnResult> {
  let result
  try {
    result = await generateText({ model, messages, tools: toolSet() })
  } catch (err) {
    if (isTransient(err)) throw new TransientProviderError(String(err))
    throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { terminal: true })
  }
  return {
    text: result.text,
    toolCalls: result.toolCalls.map(c => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })),
    usage: normalizeUsage(result.usage),
    // ai@7's GenerateTextResult exposes the generated messages directly as `responseMessages`
    // (non-deprecated); the brief's `result.response.messages` is the same data but deprecated
    // in favor of `finalStep.response` — see API-drift notes in the task report.
    responseMessages: result.responseMessages,
  }
}

function buildPrompt(ctx: ExecutorContext<LanguageModel>): string {
  const deps = Object.entries(ctx.depOutputs)
    .map(([id, out]) => `### Output of step '${id}'\n${out}`)
    .join('\n\n')
  return [
    `# Task\n${ctx.taskSpec}`,
    `# Your step: ${ctx.step.title} (role: ${ctx.step.role})\n${ctx.step.instructions}`,
    deps ? `# Upstream outputs\n${deps}` : '',
    `You have file tools scoped to your workspace. When finished (or stuck), call the 'signal' tool — its summary is the only thing downstream steps will see.`,
  ].filter(Boolean).join('\n\n')
}

export function apiLoopExecutor(): AgentExecutor<LanguageModel> {
  return {
    id: 'api-loop',
    getCapabilities: () => ({ tools: true, streaming: false }),

    async *startTurn(ctx: ExecutorContext<LanguageModel>): AsyncIterable<UnifiedEvent> {
      const messages: ModelMessage[] = [{ role: 'user', content: buildPrompt(ctx) }]
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }

      for (let iteration = 1; iteration <= ctx.step.maxIterations; iteration++) {
        const remaining = await ctx.checkpoint(`budget:${iteration}`, ctx.budgetRemainingUSD)
        if (remaining !== null && remaining <= 0) {
          yield { type: UNIFIED_EVENT_TYPE.error, class: FAILURE_CLASS.budget_exceeded, message: `budget exhausted before iteration ${iteration}` }
          return
        }

        let turn: TurnResult
        try {
          turn = await ctx.checkpoint(
            `model:${iteration}`,
            () => callModel(ctx.model, messages),
            (r): EventDraft[] => [{
              kind: EVENT_KIND.agent_call,
              // shallow-copy: `messages` keeps growing via push() after this draft is built;
              // without the copy the draft would alias the live array and later reads (R9
              // traceability) would see telescoped history instead of this iteration's snapshot.
              payload: { ...base, iteration, request: { messages: [...messages] }, response: { text: r.text, toolCalls: r.toolCalls } },
              usage: r.usage,
            }],
          )
        } catch (err) {
          // TransientProviderError retries inside the checkpoint (DBOS); reaching here means retries
          // are exhausted or the error is terminal → terminal provider failure.
          yield { type: UNIFIED_EVENT_TYPE.error, class: FAILURE_CLASS.provider_error, message: err instanceof Error ? err.message : String(err) }
          return
        }

        yield { type: UNIFIED_EVENT_TYPE.usage, usage: turn.usage }
        if (turn.text) yield { type: UNIFIED_EVENT_TYPE.text, text: turn.text }
        messages.push(...turn.responseMessages)

        const signalCall = turn.toolCalls.find(c => c.toolName === TOOL_NAME.signal)
        if (signalCall) {
          const parsed = SignalInput.safeParse(signalCall.input)
          if (!parsed.success) {
            // The assistant turn's tool_use (signal, plus any siblings) must be answered by a
            // matching tool result for EVERY call id, or a real provider rejects the next request
            // with a 400 (terminal) — a bare user-message push leaves the signal call unresolved.
            messages.push({
              role: 'tool',
              content: turn.toolCalls.map(call => ({
                type: 'tool-result',
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: {
                  type: 'json',
                  value: call.toolCallId === signalCall.toolCallId
                    ? { error: `invalid signal input: ${parsed.error.message}. Call signal again with {outcome: 'success'|'failure', summary: string}.` }
                    : { error: 'not executed: resolve the invalid signal call first' },
                },
              })),
            } as ModelMessage)
            continue // counts as an iteration (agent_error accounting, spec §9)
          }
          const signal: Signal = { ...base, outcome: parsed.data.outcome, summary: parsed.data.summary }
          await ctx.checkpoint(
            `signal:${iteration}`,
            async () => signal,
            (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { ...base, signal } }],
          )
          yield { type: UNIFIED_EVENT_TYPE.signal, signal }
          yield { type: UNIFIED_EVENT_TYPE.done }
          return
        }

        if (turn.toolCalls.length === 0) {
          messages.push({ role: 'user', content: `Continue. Use your tools, and call 'signal' when the step is complete.` })
          continue
        }

        const results = await ctx.checkpoint(
          `tools:${iteration}`,
          async () => {
            const out = []
            for (const call of turn.toolCalls) out.push(await executeTool(call.toolName, call.input, ctx.workspaceDir))
            return out
          },
          (rs): EventDraft[] => turn.toolCalls.flatMap((call, i) => [
            { kind: EVENT_KIND.tool_call, payload: { ...base, iteration, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input } },
            { kind: EVENT_KIND.tool_result, payload: { ...base, iteration, toolCallId: call.toolCallId, toolName: call.toolName, output: rs[i]!.output, isError: rs[i]!.isError } },
          ]),
        )

        for (let i = 0; i < turn.toolCalls.length; i++) {
          const call = turn.toolCalls[i]!
          yield { type: UNIFIED_EVENT_TYPE.tool_call, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }
          yield { type: UNIFIED_EVENT_TYPE.tool_result, toolCallId: call.toolCallId, toolName: call.toolName, output: results[i]!.output, isError: results[i]!.isError }
        }

        messages.push({
          role: 'tool',
          content: turn.toolCalls.map((call, i) => ({
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: 'json', value: results[i]!.output },
          })),
        } as ModelMessage)
      }

      yield { type: UNIFIED_EVENT_TYPE.error, class: FAILURE_CLASS.agent_error, message: `maxIterations (${ctx.step.maxIterations}) exhausted without signal` }
    },
  }
}
