import { z } from 'zod'
import type { PlanStep } from './plan'
import type { EventKind } from './events'

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUSD: z.number().nonnegative().nullable(),
  estimated: z.boolean(),
})
export type Usage = z.infer<typeof Usage>

export function addUsage(a: Usage, b: Usage): Usage {
  const costs = [a.costUSD, b.costUSD].filter((c): c is number => c !== null)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUSD: costs.length > 0 ? costs.reduce((x, y) => x + y, 0) : null,
    estimated: a.estimated || b.estimated,
  }
}

export const ModelCost = z.object({
  inPerMTok: z.number().nonnegative(),
  outPerMTok: z.number().nonnegative(),
})
export type ModelCost = z.infer<typeof ModelCost>

export function costUSDFor(
  costs: Record<string, ModelCost>,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const c = costs[modelId] ?? costs['*']
  if (!c) return null
  return (inputTokens * c.inPerMTok + outputTokens * c.outPerMTok) / 1_000_000
}

export const SignalOutcome = z.enum(['success', 'failure'])
export type SignalOutcome = z.infer<typeof SignalOutcome>
export const SIGNAL_OUTCOME = SignalOutcome.enum

export const Signal = z.object({
  stepId: z.string().min(1),
  runToken: z.string().min(1),
  outcome: SignalOutcome,
  summary: z.string().min(1),
})
export type Signal = z.infer<typeof Signal>

export const FailureClass = z.enum(['provider_error', 'agent_error', 'budget_exceeded', 'human_abort'])
export type FailureClass = z.infer<typeof FailureClass>
export const FAILURE_CLASS = FailureClass.enum

export const RunOutcome = z.enum(['done', 'blocked', 'cancelled'])
export type RunOutcome = z.infer<typeof RunOutcome>
export const RUN_OUTCOME = RunOutcome.enum

export const StepRunStatus = z.enum(['running', 'completed', 'failed'])
export type StepRunStatus = z.infer<typeof StepRunStatus>
export const STEP_RUN_STATUS = StepRunStatus.enum

export const UnifiedEventType = z.enum(['text', 'tool_call', 'tool_result', 'usage', 'signal', 'error', 'done'])
export type UnifiedEventType = z.infer<typeof UnifiedEventType>
export const UNIFIED_EVENT_TYPE = UnifiedEventType.enum

export const UnifiedEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), toolCallId: z.string(), toolName: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), toolCallId: z.string(), toolName: z.string(), output: z.unknown(), isError: z.boolean() }),
  z.object({ type: z.literal('usage'), usage: Usage }),
  z.object({ type: z.literal('signal'), signal: Signal }),
  z.object({ type: z.literal('error'), class: FailureClass, message: z.string() }),
  z.object({ type: z.literal('done') }),
])
export type UnifiedEvent = z.infer<typeof UnifiedEvent>

export interface ModelProvider<LM = unknown> {
  costs: Record<string, ModelCost>
  languageModel(modelId: string): LM
}

export function resolveModel<LM>(
  providers: Map<string, ModelProvider<LM>>,
  modelRef: string,
): { provider: ModelProvider<LM>; modelId: string; model: LM } {
  const slash = modelRef.indexOf('/')
  const providerId = slash === -1 ? modelRef : modelRef.slice(0, slash)
  const modelId = slash === -1 ? '' : modelRef.slice(slash + 1)
  const provider = providers.get(providerId)
  if (!provider || modelId === '')
    throw new Error(`unknown provider or malformed modelRef '${modelRef}' (expected 'provider/model')`)
  return { provider, modelId, model: provider.languageModel(modelId) }
}

export type EventDraft = { kind: EventKind; payload: Record<string, unknown>; usage?: Usage | null }

// Retry protocol between checkpoint implementations (the port) and checkpoint callers
// (executors): a fn that throws terminalError() is NOT re-run; any other throw is treated
// as transient and may be retried with backoff.
export function terminalError(message: string): Error {
  return Object.assign(new Error(message), { terminal: true })
}
export function isTerminalError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { terminal?: unknown }).terminal === true
}

export type Checkpoint = <T>(name: string, fn: () => Promise<T>, toEvents?: (result: T) => EventDraft[]) => Promise<T>

export interface ExecutorContext<LM = unknown> {
  step: PlanStep
  taskSpec: string
  depOutputs: Record<string, string>
  model: LM
  runToken: string
  workspaceDir: string
  checkpoint: Checkpoint
  budgetRemainingUSD: () => Promise<number | null>
}

export interface AgentExecutor<LM = unknown> {
  id: string
  startTurn(ctx: ExecutorContext<LM>): AsyncIterable<UnifiedEvent>
}

export interface RunHandle {
  workflowId: string
  wait(): Promise<RunOutcome>
}

export interface ExecutionPort {
  startRun(taskId: string, opts?: { cwd?: string }): Promise<RunHandle>
  retry(taskId: string, opts?: { cwd?: string }): Promise<RunHandle>
  cancelRun(taskId: string): Promise<void>
}
