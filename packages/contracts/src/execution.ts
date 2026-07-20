import { z } from 'zod'
import type { PlanStep } from './plan'
import type { EventKind } from './events'
import type { OperationSpec } from './operations'
import type { LoadedSkill, ResolvedTool } from './plugins'

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  // prompt-cache split, optional (not every provider caches). inputTokens is the TOTAL.
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costUSD: z.number().nonnegative().nullable(),
  estimated: z.boolean(),
})
export type Usage = z.infer<typeof Usage>

export function addUsage(a: Usage, b: Usage): Usage {
  const costs = [a.costUSD, b.costUSD].filter((c): c is number => c !== null)
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead || cacheWrite ? { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : {}),
    costUSD: costs.length > 0 ? costs.reduce((x, y) => x + y, 0) : null,
    estimated: a.estimated || b.estimated,
  }
}

export const ModelCost = z.object({
  inPerMTok: z.number().nonnegative(),
  outPerMTok: z.number().nonnegative(),
  // cache pricing — absent means cache tokens are priced at inPerMTok
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
})
export type ModelCost = z.infer<typeof ModelCost>

export function costUSDFor(
  costs: Record<string, ModelCost>,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cache?: { readTokens?: number; writeTokens?: number },
): number | null {
  const c = costs[modelId] ?? costs['*']
  if (!c) return null
  const read = cache?.readTokens ?? 0
  const write = cache?.writeTokens ?? 0
  const fresh = Math.max(0, inputTokens - read - write) // inputTokens is the total — split it
  return (
    fresh * c.inPerMTok +
    read * (c.cacheReadPerMTok ?? c.inPerMTok) +
    write * (c.cacheWritePerMTok ?? c.inPerMTok) +
    outputTokens * c.outPerMTok
  ) / 1_000_000
}

export const SignalOutcome = z.enum(['success', 'failure'])
export type SignalOutcome = z.infer<typeof SignalOutcome>
export const SIGNAL_OUTCOME = SignalOutcome.enum

export const Signal = z.object({
  stepId: z.string().min(1),
  runToken: z.string().min(1),
  outcome: SignalOutcome,
  summary: z.string().min(1),
  // workspace-relative paths this step declares as produced outputs — verified by the runtime
  outputs: z.array(z.string().min(1)).optional(),
})
export type Signal = z.infer<typeof Signal>

export const FailureClass = z.enum(['provider_error', 'agent_error', 'validation_error', 'budget_exceeded', 'human_abort'])
export type FailureClass = z.infer<typeof FailureClass>
export const FAILURE_CLASS = FailureClass.enum

export const RunOutcome = z.enum(['done', 'blocked', 'cancelled'])
export type RunOutcome = z.infer<typeof RunOutcome>
export const RUN_OUTCOME = RunOutcome.enum

// The thin join payload (spec D5): what a parent gets back from a resolved split.
// Same shape as the split_resolved event payload — the router composes it once.
export const SplitResult = z.object({
  splitId: z.string().min(1),
  childTaskId: z.string().min(1),
  outcome: RunOutcome,
  summary: z.string(),
  notes: z.array(z.object({ id: z.string(), scope: z.string() })),
})
export type SplitResult = z.infer<typeof SplitResult>

export const StepRunStatus = z.enum(['running', 'completed', 'failed'])
export type StepRunStatus = z.infer<typeof StepRunStatus>
export const STEP_RUN_STATUS = StepRunStatus.enum

export const UnifiedEventType = z.enum(['text', 'tool_call', 'tool_result', 'usage', 'signal', 'error', 'done', 'gate', 'feedback'])
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
  z.object({ type: z.literal('gate'), splitIds: z.array(z.string()), toolCallId: z.string() }),
  z.object({ type: z.literal('feedback'), question: z.string(), topic: z.string(), toolCallId: z.string() }),
])
export type UnifiedEvent = z.infer<typeof UnifiedEvent>

export interface ModelProvider<LM = unknown> {
  costs: Record<string, ModelCost>
  languageModel(modelId: string): LM
}

// the ONE parse of 'provider/model' refs — resolveModel and plan validation must agree
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf('/')
  return {
    providerId: slash === -1 ? ref : ref.slice(0, slash),
    modelId: slash === -1 ? '' : ref.slice(slash + 1),
  }
}

export function resolveModel<LM>(
  providers: Map<string, ModelProvider<LM>>,
  modelRef: string,
): { provider: ModelProvider<LM>; modelId: string; model: LM } {
  const { providerId, modelId } = parseModelRef(modelRef)
  const provider = providers.get(providerId)
  if (!provider || modelId === '')
    throw new Error(`unknown provider or malformed modelRef '${modelRef}' (expected 'provider/model')`)
  return { provider, modelId, model: provider.languageModel(modelId) }
}

// idempotencyKey: checkpoints derive a positional key when absent; drafts with a natural
// stable identity (e.g. artifact receipts keyed by path) set their own
export type EventDraft = { kind: EventKind; payload: Record<string, unknown>; usage?: Usage | null; idempotencyKey?: string }

// Retry protocol between checkpoint implementations (the port) and checkpoint callers
// (executors): a fn that throws terminalError() is NOT re-run; any other throw is treated
// as transient and may be retried with backoff.
export function terminalError(message: string): Error {
  return Object.assign(new Error(message), { terminal: true })
}
export function isTerminalError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'terminal' in err && err.terminal === true
}

// terminal error that also names its failure class (e.g. validation_error at step init) —
// finishFailed maps it to the right step_failed class instead of defaulting to agent_error.
export function classifiedError(cls: FailureClass, message: string): Error {
  return Object.assign(new Error(message), { terminal: true, failureClass: cls })
}
export function failureClassOf(err: unknown): FailureClass | null {
  if (typeof err !== 'object' || err === null || !('failureClass' in err)) return null
  const parsed = FailureClass.safeParse(err.failureClass)
  return parsed.success ? parsed.data : null
}

export type Checkpoint = <T>(name: string, fn: () => Promise<T>, toEvents?: (result: T) => EventDraft[]) => Promise<T>

// the enforced before/after wrapper for external model/tool effects: the journal records
// the spec before fn runs and its result (or failure) after — see OperationSpec
export type OperationCheckpoint = <T>(
  spec: OperationSpec,
  fn: () => Promise<T>,
  toEvents?: (result: T) => EventDraft[],
) => Promise<T>

export interface ExecutorContext<LM = unknown> {
  step: PlanStep
  taskSpec: string
  depOutputs: Record<string, string>
  skills: LoadedSkill[]
  extraTools: ResolvedTool[]
  model: LM
  runToken: string
  workspaceDir: string
  checkpoint: Checkpoint
  operation: OperationCheckpoint
  budgetRemainingUSD: () => Promise<number | null>
}

export interface AgentExecutor<LM = unknown> {
  id: string
  startTurn(ctx: ExecutorContext<LM>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined>
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
