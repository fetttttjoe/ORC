import { z } from 'zod'
import type { PlanStep } from './plan'
import { TASK_STATUS, type TaskStatus } from './task'
import type { EventKind } from './events'
import type { OperationSpec } from './operations'
import type { LoadedSkill, ResolvedTool } from './plugins'
import type { ClaimHit, NoteSummary } from './memory'

// Whether anything can DRIVE a run right now — the question every silent project raises first.
// Derived from the supervisor heartbeat row plus the pid file the serve process writes only once
// its runtime is ready: heartbeat+pidfile = ready, heartbeat alone = booting (projection catch-up
// beats through boot since 601bca7), a stale row = it died without cleanup, no row = nothing will
// run until `orc serve`. Lives in contracts because the CLI derives it and both UI doors render it.
// [derived: 2026-08-01 live session — every incident began as "is anything actually driving?"]
export { SUPERVISOR_HEALTH, type SupervisorHealth, type SupervisorHealthState } from './health'

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

// A model the operator can actually select, with what it costs. Discovery (live list ∪ priced
// catalog) produces these; the plan step and the CLI renderer both consume them.
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

// What a finished run looked like, read off the task it drove. Shared because two callers derive
// it — the router composing a split result, and the CLI watch that no longer holds a run handle to
// ask — and a second copy could disagree about a status the first has not seen. `failed` and every
// non-terminal status surface as blocked: RunOutcome has no 'failed', and to a caller both mean the
// same thing, the work stopped short of done.
export function runOutcomeFor(status: TaskStatus | undefined): RunOutcome {
  if (status === TASK_STATUS.done) return RUN_OUTCOME.done
  if (status === TASK_STATUS.cancelled) return RUN_OUTCOME.cancelled
  return RUN_OUTCOME.blocked
}

// The thin join payload (spec D5): what a parent gets back from a resolved split.
// Also THE split_resolved event payload schema (PAYLOAD_SCHEMAS composes it) — a re-spelled
// copy there had already been one field-comment away from drifting.
export const SplitResult = z.object({
  splitId: z.string().min(1),
  childTaskId: z.string().min(1),
  outcome: RunOutcome, // done | blocked | cancelled — NOT SignalOutcome (spec D5)
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
  // live model discovery, plugin-driven: each provider queries its own API. Optional — callers
  // fall back to the cost-table keys. Implementations must resolve (never reject) with [] or a
  // static fallback when the API is unreachable: discovery is a convenience, not a dependency.
  listModels?(): Promise<string[]>
}

// the ONE parse of a provider's model-list JSON — the three providers differed only in the list
// key ('data' vs 'models') and the id key ('id' vs 'name'), and the extraction was spelled three
// times. Anything malformed degrades to fewer ids, never a throw: discovery is a convenience,
// and listModels implementations must not reject.
export function modelIdsFrom(body: unknown, listKey: string, idKey: string): string[] {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body)
  const list = z.array(z.unknown()).safeParse(parsed.success ? parsed.data[listKey] : undefined)
  if (!list.success) return []
  return list.data.flatMap(m => {
    const entry = z.record(z.string(), z.unknown()).safeParse(m)
    const id = z.string().safeParse(entry.success ? entry.data[idKey] : undefined)
    return id.success ? [id.data] : []
  })
}

// The embedding seam — a plugin-provided text→vector encoder, mirroring ModelProvider so any
// backend (a local Ollama model today, a hosted encoder tomorrow) plugs in behind ONE interface.
// Optional across the system: when no embedder is configured, memory retrieval degrades to
// keyword-only (the whole memory subsystem is already degraded-tolerant).
export interface EmbeddingProvider {
  // one cosine-ready vector per input, in order and of equal length to `texts`. May reject on a
  // backend failure; callers catch and fall back to keyword rather than failing the operation.
  embed(texts: string[]): Promise<number[][]>
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
// Deterministic environment failures: retrying cannot change a permission or a missing path,
// so these fail on attempt 1 instead of burning the retry budget (observed live: 4 workspace
// retries on one EACCES). Transient codes (EBUSY, EAGAIN, EMFILE, …) stay retryable.
const PERMANENT_FS_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOTDIR', 'EISDIR'])
export function isTerminalError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ('terminal' in err && err.terminal === true) return true
  return 'code' in err && typeof err.code === 'string' && PERMANENT_FS_CODES.has(err.code)
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
  // Optional, additive runtime knobs (no config→executor path existed before these — maxIterations
  // reaches the loop as a frozen PlanStep field, wrong for a runtime knob). Optional so every
  // existing ctx constructor (tests, fixtures) keeps compiling untouched.
  taskId?: string // the plan this step belongs to — absent in bare test ctxs, which skip ambient capture
  memoryPreloadTokens?: number // Task 7's memory-preload budget: fed via dbos-port config, consumed by the loop's preload search
  memory?: StepMemory
}

/** One preload pull: matched statements plus the notes that matched without asserting one. */
export interface RecalledContext {
  claims: ClaimHit[]
  notes: NoteSummary[]
  /**
   * Of the delivered notes, how many could be checked against the tree at all, and how many
   * describe code that has since moved — the same `drift.ts` verdict `memory_read` flags per note
   * and `orc status` reports per corpus, so there is ONE definition of stale in the system.
   *
   * A step handed knowledge with no way to date it must re-derive everything to be safe, which is
   * the most expensive thing a scout does. Absent when nothing could be checked (no repository,
   * unreachable revision, no note declaring paths): unknown is never reported as current.
   *
   * `unknown` counts notes carrying a sourceRevision and declared paths whose revision was
   * UNREACHABLE — they are no longer folded into `checkable`/`drifted`, they get their own count.
   */
  currency?: { checkable: number; drifted: number; unknown: number }
}

// The step's own memory, bound by the runtime from the memory plugin. The executor decides only
// WHEN (before the first prompt, after the signal) and wraps each call for durability; what gets
// searched, recorded, written and linked is the memory domain's business.
//
// It exists because the executor was doing that job by reaching into extraTools, matching
// 'memory_search'/'memory_write' by name and forging tool-call ids to drive them — which made the
// executor a second writer of memory events alongside the store.
export interface StepMemory {
  /**
   * Context for the first prompt. Recording the pull is the implementation's business.
   * Both surfaces come from ONE call so they share ONE budget and ONE replay checkpoint — two
   * calls would record two values and could rebuild messages[0] differently on recovery.
   */
  recall(budget: number): Promise<RecalledContext>
  /**
   * The claims a file edit puts at risk: every recorded claim that cites one of `paths`.
   *
   * A step that changes code falsifies the claims describing what that code used to do, and the
   * knowledge protocol obliges it to retire them — but "remember to check" is the weakest possible
   * enforcement, and it failed: a run added a CLI flag while a claim saying that command "accepts
   * no options" stayed live, so one note asserted a thing and its opposite.
   *
   * The join is deterministic, not inferential: claims name their source file by convention, so
   * citing text is a string match. Judging whether a cited claim is now FALSE is the agent's job —
   * nothing here can know that, which is exactly why this surfaces candidates rather than retiring
   * anything itself.
   */
  claimsCiting(paths: readonly string[]): Promise<ClaimHit[]>
  /** What the finished step leaves behind. Best-effort: never throws into the step. */
  capture(signal: { outcome: SignalOutcome; summary: string }): Promise<void>
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
