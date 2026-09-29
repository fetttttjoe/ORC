import { EVENT_KIND, NOTE_TIER, PAYLOAD_SCHEMAS, noteLabel, type EventKind, type EventRecord, type Plan } from '@orc/contracts'
import { z } from 'zod'
import { noteNodeId } from './graph'
import type { LogRow as WireLogRow } from './wire'

// the row IS the wire schema the browser parses — two declarations drifted once (`failure`)
export type LogRow = z.infer<typeof WireLogRow>

// the one truncator — shared with copilot.ts (was duplicated there)
export const snip = (v: unknown, n = 140): string => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// agent_call.response is z.unknown() in the contract; this parses only what the line renders
const AgentResponse = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ toolName: z.string() })).optional(),
})

const planLine = (plan: Plan): string =>
  `v${plan.version} · ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} · ${plan.strategyRef}`

// the fields a kind's summary may fill in; everything else on the row comes off the envelope
type PartialRow = Partial<Pick<LogRow, 'line' | 'noteRef' | 'authorTaskId' | 'exchange'>>
type Handler = (e: EventRecord) => PartialRow | null

// the schema is an argument: indexing PAYLOAD_SCHEMAS by a type parameter widens payload to every kind (measured)
function entry<S extends z.ZodType>(
  schema: S,
  handle: (payload: z.infer<S>, e: EventRecord) => PartialRow,
): Handler {
  return e => {
    const parsed = schema.safeParse(e.payload)
    return parsed.success ? handle(parsed.data, e) : null
  }
}

// satisfies: a kind without an entry fails the build
const SUMMARIZE = {
  [EVENT_KIND.task_created]: entry(PAYLOAD_SCHEMAS.task_created, p => ({
    line: `${p.task.title} (${p.task.type}) status=${p.task.status}`,
  })),
  [EVENT_KIND.plan_proposed]: entry(PAYLOAD_SCHEMAS.plan_proposed, p => ({ line: planLine(p.plan) })),
  [EVENT_KIND.plan_edited]: entry(PAYLOAD_SCHEMAS.plan_edited, p => ({ line: planLine(p.plan) })),
  [EVENT_KIND.plan_approved]: entry(PAYLOAD_SCHEMAS.plan_approved, p => ({
    line: `v${p.version} approved by ${p.approvedBy}${p.ruleIndex !== undefined ? ` (rule ${p.ruleIndex})` : ''}`,
  })),
  [EVENT_KIND.run_requested]: entry(PAYLOAD_SCHEMAS.run_requested, p => ({
    line: `${p.retry ? 'retry' : 'run'}${p.cwd ? ` in ${p.cwd}` : ''}`,
  })),
  [EVENT_KIND.run_started]: entry(PAYLOAD_SCHEMAS.run_started, p => ({
    line: `plan v${p.planVersion} · workflow ${p.workflowId}${p.retryIndex > 0 ? ` (retry ${p.retryIndex})` : ''}`,
  })),
  [EVENT_KIND.step_started]: entry(PAYLOAD_SCHEMAS.step_started, (p, e) => ({
    line: `${e.stepId ?? '?'} · attempt ${p.attempt}`,
  })),
  [EVENT_KIND.skill_loaded]: entry(PAYLOAD_SCHEMAS.skill_loaded, p => ({
    line: `${p.name} (${p.hash.slice(0, 8)})`,
  })),
  [EVENT_KIND.rate_limit_wait]: entry(PAYLOAD_SCHEMAS.rate_limit_wait, p => ({
    line: `waiting ${Math.round(p.waitMs / 1000)}s — ${snip(p.errorMessage, 100)}`,
  })),
  [EVENT_KIND.agent_call]: entry(PAYLOAD_SCHEMAS.agent_call, p => {
    const r = AgentResponse.safeParse(p.response)
    const text = r.success ? r.data.text : undefined
    const calls = (r.success ? r.data.toolCalls ?? [] : []).map(c => c.toolName).join(',')
    return { line: `iter ${p.iteration}  ${text ? `"${snip(text, 110)}"` : ''}${calls ? `  →calls[${calls}]` : ''}` }
  }),
  [EVENT_KIND.tool_call]: entry(PAYLOAD_SCHEMAS.tool_call, p => ({
    line: `${p.toolName}(${snip(p.input, 110)})`,
  })),
  [EVENT_KIND.tool_result]: entry(PAYLOAD_SCHEMAS.tool_result, p => ({
    line: `${p.toolName} ${p.isError ? 'ERROR ' : ''}${snip(p.output, 110)}`,
  })),
  [EVENT_KIND.memory_written]: entry(PAYLOAD_SCHEMAS.memory_written, p => {
    const nt = p.note
    return {
      line: `${nt.id} kind=${noteLabel(nt)} links=${nt.links.length} sources=${nt.tier === NOTE_TIER.semantic ? nt.sources.length : 0}`,
      noteRef: noteNodeId(nt.scope, nt.id),
      authorTaskId: p.author.taskId ?? null,
    }
  }),
  [EVENT_KIND.memory_deleted]: entry(PAYLOAD_SCHEMAS.memory_deleted, p => ({
    line: p.id,
    noteRef: noteNodeId(p.scope, p.id),
    authorTaskId: p.author.taskId ?? null,
  })),
  [EVENT_KIND.memory_accessed]: entry(PAYLOAD_SCHEMAS.memory_accessed, p => ({
    line: `${p.id} ${p.mode}`,
    noteRef: noteNodeId(p.scope, p.id),
  })),
  [EVENT_KIND.memory_topic_accessed]: entry(PAYLOAD_SCHEMAS.memory_topic_accessed, p => ({
    line: `${p.label} (${p.topicKey})`,
  })),
  [EVENT_KIND.memory_verified]: entry(PAYLOAD_SCHEMAS.memory_verified, p => ({
    line: `${p.id} verified @ ${p.stamp.revision.slice(0, 8)} by ${p.stamp.by}`,
  })),
  [EVENT_KIND.memory_outcome]: entry(PAYLOAD_SCHEMAS.memory_outcome, p => ({
    line: `${p.id} → ${p.outcome}`,
  })),
  [EVENT_KIND.knowledge_delivered]: entry(PAYLOAD_SCHEMAS.knowledge_delivered, p => ({
    line: `${p.mode} ${p.ids.length} claim(s) · ${snip(p.subject, 80)}`,
    authorTaskId: p.author.taskId ?? null,
  })),
  [EVENT_KIND.knowledge_written]: entry(PAYLOAD_SCHEMAS.knowledge_written, p => ({
    line: `+${p.added.length} ~${p.changed.length} -${p.retired.length}${p.why === null ? '' : ` · ${snip(p.why, 80)}`}`,
    authorTaskId: p.author.taskId ?? null,
  })),
  [EVENT_KIND.signal_received]: entry(PAYLOAD_SCHEMAS.signal_received, p => ({
    line: `${p.signal.outcome}: ${snip(p.signal.summary, 90)}`,
  })),
  [EVENT_KIND.step_completed]: entry(PAYLOAD_SCHEMAS.step_completed, (p, e) => ({
    line: `${e.stepId ? `${e.stepId} ` : ''}→ ${snip(p.summary, 120)}`,
  })),
  [EVENT_KIND.step_failed]: entry(PAYLOAD_SCHEMAS.step_failed, (p, e) => ({
    line: `${e.stepId ? `${e.stepId} ` : ''}[${p.class}] ${snip(p.message, 120)}`,
  })),
  [EVENT_KIND.split_proposed]: entry(PAYLOAD_SCHEMAS.split_proposed, p => ({
    line: `child ${p.childTaskId} from ${p.stepId}`,
  })),
  [EVENT_KIND.split_resolved]: entry(PAYLOAD_SCHEMAS.split_resolved, p => ({
    line: `${p.childTaskId} → ${p.outcome}: ${snip(p.summary, 90)}`,
  })),
  [EVENT_KIND.feedback_requested]: entry(PAYLOAD_SCHEMAS.feedback_requested, p => ({
    line: `Q: ${snip(p.question, 120)}`,
  })),
  [EVENT_KIND.feedback_provided]: entry(PAYLOAD_SCHEMAS.feedback_provided, p => ({
    line: `A: ${snip(p.text, 120)}`,
  })),
  [EVENT_KIND.plan_annotated]: entry(PAYLOAD_SCHEMAS.plan_annotated, p => ({
    line: `on ${p.targetNote} (v${p.planVersion}): ${snip(p.text, 100)}`,
  })),
  [EVENT_KIND.analysis_completed]: entry(PAYLOAD_SCHEMAS.analysis_completed, p => ({
    line: `analyzed=${p.analyzed} confidence=${p.confidence} gaps=${p.gaps.length} claims=${p.claimsWritten}`,
  })),
  [EVENT_KIND.artifact_produced]: entry(PAYLOAD_SCHEMAS.artifact_produced, p => ({
    line: `${p.path} · ${(p.size / 1024).toFixed(1)} KB · sha ${p.sha256.slice(0, 8)}`,
  })),
  [EVENT_KIND.task_status_changed]: entry(PAYLOAD_SCHEMAS.task_status_changed, p => ({
    line: `${p.from} → ${p.to}`,
  })),
  [EVENT_KIND.copilot_exchange]: entry(PAYLOAD_SCHEMAS.copilot_exchange, p => ({
    line: `“${snip(p.user, 70)}” → “${snip(p.assistant, 90)}”${p.toolCalls.length ? ` (${p.toolCalls.length} tools)` : ''}`,
    exchange: p,
  })),
  [EVENT_KIND.models_discovered]: entry(PAYLOAD_SCHEMAS.models_discovered, p => ({
    line: `${p.providerId}: ${p.models.length} model${p.models.length === 1 ? '' : 's'}`,
  })),
  [EVENT_KIND.reaction_failed]: entry(PAYLOAD_SCHEMAS.reaction_failed, p => ({
    line: `${p.reaction} failed: ${snip(p.message, 100)}`,
  })),
  [EVENT_KIND.commit_recorded]: entry(PAYLOAD_SCHEMAS.commit_recorded, p => ({
    line: `${p.sha.slice(0, 8)} · ${p.paths.length} file${p.paths.length === 1 ? '' : 's'}${p.workspaceId ? ` in ${p.workspaceId}` : ''}`,
  })),
  [EVENT_KIND.workspace_created]: entry(PAYLOAD_SCHEMAS.workspace_created, p => {
    const w = p.workspace
    return { line: `${w.title} · ${w.branch ?? w.kind} · ${w.cwd}` }
  }),
  [EVENT_KIND.workspace_retitled]: entry(PAYLOAD_SCHEMAS.workspace_retitled, p => ({
    line: `${p.workspaceId} → "${p.title}"`,
  })),
  [EVENT_KIND.workspace_archived]: entry(PAYLOAD_SCHEMAS.workspace_archived, p => ({
    line: `${p.workspaceId} ${p.archived ? 'archived' : 'restored'}`,
  })),
  [EVENT_KIND.workspace_merged]: entry(PAYLOAD_SCHEMAS.workspace_merged, p => ({
    line: `${p.workspaceId} merged ${p.mergeCommit.slice(0, 8)} → ${p.trunk}`,
  })),
  [EVENT_KIND.chat_opened]: entry(PAYLOAD_SCHEMAS.chat_opened, p => ({
    line: `${p.kind} "${p.title}"${p.taskId ? ` on ${p.taskId}` : ''}`,
  })),
  [EVENT_KIND.operation_started]: entry(PAYLOAD_SCHEMAS.operation_started, p => ({
    line: `${p.operationKind} ${p.name}`,
  })),
  [EVENT_KIND.operation_completed]: entry(PAYLOAD_SCHEMAS.operation_completed, p => ({
    line: `${p.operationId} attempt ${p.attempt} → ${snip(p.after, 90)}`,
  })),
  [EVENT_KIND.operation_failed]: entry(PAYLOAD_SCHEMAS.operation_failed, p => ({
    line: `${p.operationId} attempt ${p.attempt} FAILED: ${snip(p.error, 90)}`,
  })),
} satisfies Record<EventKind, Handler>

// shared by the web log, `orc watch` and any TUI feed; a payload that fails its schema gets the generic snip
export function summarizeEvent(e: EventRecord): LogRow {
  const r = SUMMARIZE[e.kind](e)
  return {
    seq: e.seq, ts: e.ts, kind: e.kind, taskId: e.taskId, stepId: e.stepId, chatId: e.chatId, door: e.door,
    line: r?.line ?? snip(e.payload, 90),
    authorTaskId: r?.authorTaskId ?? null,
    noteRef: r?.noteRef ?? null,
    ...(r?.exchange ? { exchange: r.exchange } : {}),
  }
}
