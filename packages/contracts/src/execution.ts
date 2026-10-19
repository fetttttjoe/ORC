import { z } from 'zod'
import type { PlanStep } from './plan'
import { TASK_STATUS, type TaskStatus } from './task'
import type { EventDraft } from './events'
import type { OperationSpec } from './operations'
import type { LoadedSkill, ResolvedTool } from './plugins'
import type { Origin } from './origin'
import { KnowledgeRef } from './knowledge-ref'
// kept type-only and separate from KnowledgeRef above: knowledge.ts pulls node:crypto, and only a fully-`type` import is erased before graph-ui's bundle (browser-leaves.test.ts)
import type { KnowledgeClaim, PreloadedClaim } from './knowledge'

// Whether anything can DRIVE a run right now — the question every silent project raises first.
// Derived from the supervisor heartbeat row plus the pid file the serve process writes only once
// its runtime is ready: heartbeat+pidfile = ready, heartbeat alone = booting (projection catch-up
// beats through boot since 601bca7), a stale row = it died without cleanup, no row = nothing will
// run until `orc serve`. Lives in contracts because the CLI derives it and both UI doors render it.
// [derived: 2026-08-01 live session — every incident began as "is anything actually driving?"]
export { KnowledgeHealth, KnowledgeHealthState, SUPERVISOR_HEALTH, type SupervisorHealth, type SupervisorHealthState } from './health'

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

// `partial` is the honest third state exhaustion used to hide: the step is neither done nor
// broken — the agent ran out of iterations mid-job and REPORTS what remains instead of dying as
// an agent_error whose retry forgets everything but the workspace. The AGENT only ever reports;
// the RUNTIME grants: continuation rounds are auto-granted while budget and the round cap allow,
// then escalate to the human gate (feedback_requested — the ask_human machinery). An agent asked
// "do you want more budget" always says yes, which is why there is no request_iterations tool.
export enum SignalOutcome {
  success = 'success',
  failure = 'failure',
  partial = 'partial',
}

// Auto-granted continuation rounds per step attempt before the human gate takes over. The USD
// budget stays the true ceiling (checked per grant); this cap only bounds how long a step can
// re-run itself when NO budget is configured. [conjecture — no corpus of partial-signalling
// steps exists yet; revisit against real runs, and make it a config knob if one size proves wrong]
export const MAX_AUTO_CONTINUATIONS = 3

// ONE spelling of the continuation gate's feedback topic: the port's ask, the recv it parks on,
// and any reader tracing a feedback event back to its round all derive it here.
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

/**
 * Why a step stopped. Every class but `rejected` is a MALFUNCTION — something went wrong, and
 * running it again may well work.
 *
 * `rejected` is the odd one and the reason this enum grew: the step ran correctly and CONCLUDED
 * that the work is not acceptable (an auditor signalling `failure`, a verifier refusing a result).
 * That used to be filed as `agent_error`, which made a considered verdict indistinguishable from a
 * crash — so the operator was offered a retry. But a retry only re-runs what did not complete
 * (see completedStepIds), so the rejecting step re-ran over identical sibling outputs and
 * reproduced the identical verdict, forever. Measured: three consecutive audit passes, same three
 * defects, same failure. A verdict is answered by changing the PLAN, never by repeating the step.
 */
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

// What a finished run looked like, read off the task it drove. Shared because two callers derive
// it — the router composing a split result, and the CLI watch that no longer holds a run handle to
// ask — and a second copy could disagree about a status the first has not seen. `failed` and every
// non-terminal status surface as blocked: RunOutcome has no 'failed', and to a caller both mean the
// same thing, the work stopped short of done.
export function runOutcomeFor(status: TaskStatus | undefined): RunOutcome {
  if (status === TASK_STATUS.done) return RunOutcome.done
  if (status === TASK_STATUS.cancelled) return RunOutcome.cancelled
  return RunOutcome.blocked
}

// The thin join payload (spec D5): what a parent gets back from a resolved split.
// Also THE split_resolved event payload schema (PAYLOAD_SCHEMAS composes it) — a re-spelled
// copy there had already been one field-comment away from drifting.
export const SplitResult = z.object({
  splitId: z.string().min(1),
  childTaskId: z.string().min(1),
  outcome: z.enum(RunOutcome), // done | blocked | cancelled — NOT SignalOutcome (spec D5)
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
  // live model discovery, plugin-driven: each provider queries its own API. Optional — callers
  // fall back to the cost-table keys. An implementation REJECTS when it cannot answer — network
  // failure, bad status, unparseable body, missing credentials; [] means it ANSWERED and nothing
  // usable exists. The split is load-bearing for discovery's append-on-change, which must tell
  // "positively empty" from silence: with [] meaning both, an emptied catalog could never be
  // recorded (ollama's embedding filter left retired encoders in the served catalog, observed
  // 2026-08-03), and a swallowed openai blip would append models: [] over the real catalog.
  // Callers isolate the rejection per provider — buildModelDiscovery already does, marking the
  // provider reachable: false and keeping its last recorded catalog.
  listModels?(): Promise<string[]>
}

// the ONE parse of a provider's model-list JSON — the providers differed only in the list key
// ('data' vs 'models') and the id key ('id' vs 'name'), and the extraction was spelled three
// times. A malformed ENTRY degrades to fewer ids (the API answered; one odd row is not silence),
// but a body without the list array THROWS: per the listModels contract above, an unparseable
// body is a failure to answer, not an empty catalog.
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
  const parsed = z.enum(FailureClass).safeParse(err.failureClass)
  return parsed.success ? parsed.data : null
}

export type Checkpoint = <T>(name: string, fn: () => Promise<T>, toEvents?: (result: T) => EventDraft[]) => Promise<T>

// the enforced before/after wrapper for external model/tool effects: the journal records
// the spec before fn runs and its result (or failure) after — see OperationSpec.
// attempt: the journal's 1-based count for this operationId — a checkpoint nested in fn keys by it
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
  // The interaction this step runs inside — the RUN's chat, so every event a step appends
  // correlates with the run that started it. Required: a step that cannot name its chat writes
  // events no transcript can assemble.
  origin: Origin
  workspaceDir: string
  checkpoint: Checkpoint
  operation: OperationCheckpoint
  budgetRemainingUSD: () => Promise<number | null>
  // Optional, additive runtime knobs (no config→executor path existed before these — maxIterations
  // reaches the loop as a frozen PlanStep field, wrong for a runtime knob). Optional so every
  // existing ctx constructor (tests, fixtures) keeps compiling untouched.
  taskId?: string // the plan this step belongs to — absent in bare test ctxs
  knowledgePreloadTokens?: number
  knowledge?: StepKnowledge
  // set by the port on a retry: what the previous attempt of this step failed with
  priorFailure?: { attempt: number; class: FailureClass; message: string }
  // Set by the port on a continuation round (a previous round signalled `partial`): the previous
  // round's summary IS the handoff — the same "your summary is the only output downstream sees"
  // seam, pointed at your own successor. The loop renders it into the first prompt; nothing else
  // changes shape, so round 0 constructors (tests, fixtures) keep compiling untouched.
  continuation?: { round: number; summary: string }
  isCancelled?: () => Promise<boolean>
}

/** The step's own knowledge claims: what its first prompt is handed, and what an edited path puts at risk. */
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
  // origin: a cancel is an interaction like any other — the canceller's door is stamped on every
  // status the subtree sweep appends, so the log says who stopped the run.
  cancelRun(taskId: string, origin: Origin): Promise<void>
}
