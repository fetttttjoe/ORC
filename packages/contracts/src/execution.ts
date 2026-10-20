import { z } from 'zod'
import type { PlanStep } from './plan'
import { TASK_STATUS, type TaskStatus } from './task'
import type { EventDraft } from './events'
import type { OperationSpec } from './operations'
import type { LoadedSkill, ResolvedTool } from './plugins'
import type { Origin } from './origin'
import { KnowledgeRef } from './knowledge-ref'
// type-only: knowledge.ts pulls node:crypto, which graph-ui's bundle must not include
import type { KnowledgeClaim, PreloadedClaim } from './knowledge'

export { KnowledgeHealth, KnowledgeHealthState, SupervisorHealthState, type SupervisorHealth } from './health'

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

// the one zero — folds and views start from this instead of hand-rolling the literal
export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUSD: null, estimated: false }

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

export interface ModelOption { ref: string; cost: ModelCost | null }

// null = unpriced, so callers render the ref bare rather than inventing a rate.
export const formatModelRate = (c: ModelCost | null | undefined): string | null =>
  c ? `$${c.inPerMTok}/M in · $${c.outPerMTok}/M out` : null

export const formatModelOption = (o: ModelOption): string => {
  const rate = formatModelRate(o.cost)
  return rate ? `${o.ref} (${rate})` : o.ref
}

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

export enum SignalOutcome {
  success = 'success',
  failure = 'failure',
  partial = 'partial',
}

// caps self-re-runs when no budget is set; the USD budget stays the real ceiling
export const MAX_AUTO_CONTINUATIONS = 3

export const continuationTopic = (stepId: string, round: number): string => `continue:${stepId}:${round}`

export const Signal = z.object({
  stepId: z.string().min(1),
  runToken: z.string().min(1),
  outcome: z.enum(SignalOutcome),
  summary: z.string().min(1),
  // workspace-relative paths this step declares as produced outputs — verified by the runtime
  outputs: z.array(z.string().min(1)).optional(),
})
export type Signal = z.infer<typeof Signal>

// every class but `rejected` is a malfunction a rerun may clear
export enum FailureClass {
  provider_error = 'provider_error',
  agent_error = 'agent_error',
  validation_error = 'validation_error',
  budget_exceeded = 'budget_exceeded',
  human_abort = 'human_abort',
  rejected = 'rejected',
}

/** Classes a rerun could plausibly clear. `rejected` is absent by definition — see above. */
export const RETRYABLE_FAILURE: ReadonlySet<FailureClass> = new Set([
  FailureClass.provider_error, FailureClass.agent_error, FailureClass.validation_error,
  FailureClass.budget_exceeded, FailureClass.human_abort,
])

export enum RunOutcome {
  done = 'done',
  blocked = 'blocked',
  cancelled = 'cancelled',
}

// failed and every non-terminal status map to blocked: RunOutcome has no 'failed'
export function runOutcomeFor(status: TaskStatus | undefined): RunOutcome {
  if (status === TASK_STATUS.done) return RunOutcome.done
  if (status === TASK_STATUS.cancelled) return RunOutcome.cancelled
  return RunOutcome.blocked
}

// also the split_resolved event payload schema (PAYLOAD_SCHEMAS composes it)
export const SplitResult = z.object({
  splitId: z.string().min(1),
  childTaskId: z.string().min(1),
  outcome: z.enum(RunOutcome), // done | blocked | cancelled — NOT SignalOutcome
  summary: z.string(),
  claims: z.array(KnowledgeRef),
})
export type SplitResult = z.infer<typeof SplitResult>

export enum StepRunStatus {
  running = 'running',
  completed = 'completed',
  failed = 'failed',
}

export enum UnifiedEventType {
  text = 'text',
  tool_call = 'tool_call',
  tool_result = 'tool_result',
  usage = 'usage',
  signal = 'signal',
  error = 'error',
  done = 'done',
  gate = 'gate',
  feedback = 'feedback',
}

export const UnifiedEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), toolCallId: z.string(), toolName: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), toolCallId: z.string(), toolName: z.string(), output: z.unknown(), isError: z.boolean() }),
  z.object({ type: z.literal('usage'), usage: Usage }),
  z.object({ type: z.literal('signal'), signal: Signal }),
  z.object({ type: z.literal('error'), class: z.enum(FailureClass), message: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('gate'), splitIds: z.array(z.string()), toolCallId: z.string() }),
  z.object({ type: z.literal('feedback'), question: z.string(), topic: z.string(), toolCallId: z.string() }),
])
export type UnifiedEvent = z.infer<typeof UnifiedEvent>

export interface ModelProvider<LM = unknown> {
  costs: Record<string, ModelCost>
  languageModel(modelId: string): LM
  // rejects when it cannot answer; [] means it answered and nothing usable exists
  listModels?(): Promise<string[]>
}

// a malformed entry yields fewer ids; a body without the list array throws
export function modelIdsFrom(body: unknown, listKey: string, idKey: string): string[] {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body)
  const list = z.array(z.unknown()).safeParse(parsed.success ? parsed.data[listKey] : undefined)
  if (!list.success) throw new Error(`model-list body has no '${listKey}' array`)
  return list.data.flatMap(m => {
    const entry = z.record(z.string(), z.unknown()).safeParse(m)
    const id = z.string().safeParse(entry.success ? entry.data[idKey] : undefined)
    return id.success ? [id.data] : []
  })
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

// a fn that throws terminalError() is not re-run; any other throw is retryable
export function terminalError(message: string): Error {
  return Object.assign(new Error(message), { terminal: true })
}
// retrying cannot fix these, so they fail on attempt 1
const PERMANENT_FS_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOTDIR', 'EISDIR'])
export function isTerminalError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ('terminal' in err && err.terminal === true) return true
  return 'code' in err && typeof err.code === 'string' && PERMANENT_FS_CODES.has(err.code)
}

export function classifiedError(cls: FailureClass, message: string): Error {
  return Object.assign(new Error(message), { terminal: true, failureClass: cls })
}
export function failureClassOf(err: unknown): FailureClass | null {
  if (typeof err !== 'object' || err === null || !('failureClass' in err)) return null
  const parsed = z.enum(FailureClass).safeParse(err.failureClass)
  return parsed.success ? parsed.data : null
}

export type Checkpoint = <T>(name: string, fn: () => Promise<T>, toEvents?: (result: T) => EventDraft[]) => Promise<T>

// attempt: the journal's 1-based count for this operationId; nested checkpoints key by it
export type OperationCheckpoint = <T>(
  spec: OperationSpec,
  fn: (attempt: number) => Promise<T>,
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
  // the run's chat: a step that cannot name its chat writes events no transcript can assemble
  origin: Origin
  workspaceDir: string
  checkpoint: Checkpoint
  operation: OperationCheckpoint
  budgetRemainingUSD: () => Promise<number | null>
  taskId?: string // the plan this step belongs to — absent in bare test ctxs
  knowledgePreloadTokens?: number
  knowledge?: StepKnowledge
  // set by the port on a retry: what the previous attempt of this step failed with
  priorFailure?: { attempt: number; class: FailureClass; message: string }
  // set on a continuation round: the previous round's summary is the handoff into the first prompt
  continuation?: { round: number; summary: string }
  isCancelled?: () => Promise<boolean>
}

/** the step's own claims: handed to its first prompt, put at risk by an edited path */
export interface StepKnowledge {
  claimsAt(paths: readonly string[]): Promise<KnowledgeClaim[]>
  preload(budget: number, round: number): Promise<PreloadedClaim[]>
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
  cancelRun(taskId: string, origin: Origin): Promise<void>
}
