import { EVENT_KIND, NOTE_TIER, PAYLOAD_SCHEMAS, noteLabel, type CopilotExchangePayload, type EventRecord } from '@orc/contracts'
import { z } from 'zod'
import { noteNodeId } from './graph'

export interface LogRow {
  seq: number
  ts: string
  kind: string
  taskId: string | null
  stepId: string | null
  line: string
  // the task that AUTHORED a project-scoped (envelope taskId null) memory_written/memory_deleted
  // row, read from payload.author.taskId — the same provenance graph.ts's EDGE.wrote uses. Null
  // for every other kind (they're already attributed by the envelope taskId) and for ownerless
  // memory rows (a human/cli-authored global note). shouldAdmitLogRow uses it to attribute a
  // null-taskId memory row to its writing task under a per-task Log filter.
  authorTaskId: string | null
  noteRef: string | null // graph.ts noteNodeId(scope, id) for memory events — lets log rows link without string-parsing
  // full exchange for copilot_exchange rows — the chat pane rebuilds real bubbles from the log
  // (same side-channel pattern as noteRef; other consumers render `line` and ignore this)
  exchange?: CopilotExchangePayload
}

// the one truncator — shared with copilot.ts (was duplicated there)
export const snip = (v: unknown, n = 140): string => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// agent_call.response is z.unknown() in the contract (the provider owns that shape) — this is
// only the subset the summary line renders, parsed instead of cast.
const AgentResponse = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ toolName: z.string() })).optional(),
})

// One line per event — shared by the web log view, debug-tail, and any future TUI feed.
// Payloads parse through the SAME per-kind schemas the store validates appends against
// (PAYLOAD_SCHEMAS), so nothing in a real log can fail here; pre-schema history that does fail
// falls back to the generic snip an unknown kind gets, never to "undefined"-laced fields.
export function summarizeEvent(e: EventRecord): LogRow {
  const p = e.payload
  let line: string | null = null
  let noteRef: string | null = null
  // authored-by-task for the two project-scoped memory kinds (author.taskId may be absent —
  // ownerless/human-written note — in which case it stays null)
  let authorTaskId: string | null = null
  let exchange: CopilotExchangePayload | undefined
  switch (e.kind) {
    case EVENT_KIND.step_started: {
      const d = PAYLOAD_SCHEMAS.step_started.safeParse(p)
      if (d.success) line = `${e.stepId ?? '?'} · attempt ${d.data.attempt}`
      break
    }
    case EVENT_KIND.agent_call: {
      const d = PAYLOAD_SCHEMAS.agent_call.safeParse(p)
      if (!d.success) break
      const r = AgentResponse.safeParse(d.data.response)
      const text = r.success ? r.data.text : undefined
      const calls = (r.success ? r.data.toolCalls ?? [] : []).map(c => c.toolName).join(',')
      line = `iter ${d.data.iteration}  ${text ? `"${snip(text, 110)}"` : ''}${calls ? `  →calls[${calls}]` : ''}`
      break
    }
    case EVENT_KIND.tool_call: {
      const d = PAYLOAD_SCHEMAS.tool_call.safeParse(p)
      if (d.success) line = `${d.data.toolName}(${snip(d.data.input, 110)})`
      break
    }
    case EVENT_KIND.tool_result: {
      const d = PAYLOAD_SCHEMAS.tool_result.safeParse(p)
      if (d.success) line = `${d.data.toolName} ${d.data.isError ? 'ERROR ' : ''}${snip(d.data.output, 110)}`
      break
    }
    case EVENT_KIND.memory_written: {
      const d = PAYLOAD_SCHEMAS.memory_written.safeParse(p)
      if (!d.success) break
      const nt = d.data.note
      line = `${nt.id} kind=${noteLabel(nt)} links=${nt.links.length} sources=${nt.tier === NOTE_TIER.semantic ? nt.sources.length : 0}`
      noteRef = noteNodeId(nt.scope, nt.id)
      authorTaskId = d.data.author.taskId ?? null
      break
    }
    case EVENT_KIND.memory_deleted: {
      const d = PAYLOAD_SCHEMAS.memory_deleted.safeParse(p)
      if (d.success) { line = d.data.id; noteRef = noteNodeId(d.data.scope, d.data.id); authorTaskId = d.data.author.taskId ?? null }
      break
    }
    case EVENT_KIND.memory_accessed: {
      const d = PAYLOAD_SCHEMAS.memory_accessed.safeParse(p)
      if (d.success) { line = `${d.data.id} ${d.data.mode}`; noteRef = noteNodeId(d.data.scope, d.data.id) }
      break
    }
    case EVENT_KIND.signal_received: {
      const d = PAYLOAD_SCHEMAS.signal_received.safeParse(p)
      if (d.success) line = `${d.data.signal.outcome}: ${snip(d.data.signal.summary, 90)}`
      break
    }
    case EVENT_KIND.step_completed: {
      const d = PAYLOAD_SCHEMAS.step_completed.safeParse(p)
      if (d.success) line = `${e.stepId ? `${e.stepId} ` : ''}→ ${snip(d.data.summary, 120)}`
      break
    }
    case EVENT_KIND.step_failed: {
      const d = PAYLOAD_SCHEMAS.step_failed.safeParse(p)
      if (d.success) line = `${e.stepId ? `${e.stepId} ` : ''}[${d.data.class}] ${snip(d.data.message, 120)}`
      break
    }
    case EVENT_KIND.feedback_requested: {
      const d = PAYLOAD_SCHEMAS.feedback_requested.safeParse(p)
      if (d.success) line = `Q: ${snip(d.data.question, 120)}`
      break
    }
    case EVENT_KIND.feedback_provided: {
      const d = PAYLOAD_SCHEMAS.feedback_provided.safeParse(p)
      if (d.success) line = `A: ${snip(d.data.text, 120)}`
      break
    }
    case EVENT_KIND.artifact_produced: {
      const d = PAYLOAD_SCHEMAS.artifact_produced.safeParse(p)
      if (d.success) line = `${d.data.path} · ${(d.data.size / 1024).toFixed(1)} KB · sha ${d.data.sha256.slice(0, 8)}`
      break
    }
    case EVENT_KIND.task_status_changed: {
      const d = PAYLOAD_SCHEMAS.task_status_changed.safeParse(p)
      if (d.success) line = `${d.data.from} → ${d.data.to}`
      break
    }
    case EVENT_KIND.copilot_exchange: {
      const d = PAYLOAD_SCHEMAS.copilot_exchange.safeParse(p)
      if (!d.success) break
      exchange = d.data
      line = `“${snip(d.data.user, 70)}” → “${snip(d.data.assistant, 90)}”${d.data.toolCalls.length ? ` (${d.data.toolCalls.length} tools)` : ''}`
      break
    }
    // operation_completed/failed carry only operationId/attempt/after|error — the old line read
    // p.kind/p.name, which those payloads never had, and rendered a lone space; the snip fallback
    // below says more
    case EVENT_KIND.operation_started: {
      const d = PAYLOAD_SCHEMAS.operation_started.safeParse(p)
      if (d.success) line = `${d.data.operationKind} ${d.data.name}`
      break
    }
    default: break
  }
  return { seq: e.seq, ts: e.ts, kind: e.kind, taskId: e.taskId, stepId: e.stepId, line: line ?? snip(p, 90), authorTaskId, noteRef, ...(exchange ? { exchange } : {}) }
}

// The ONE admit/reject rule for a per-task Log filter, shared by the server-side initial batch
// (sessions.ts log()) and the live SSE tail (the web app's ledger), so the two
// can never drift. `taskFilter` is the task whose Log tab is open (null = whole-project view,
// which admits everything).
//
// A row's ENVELOPE taskId attributes step-scoped events (step_started/tool_call/…) — those never
// leak cross-task, since `row.taskId === taskFilter` alone excludes another task's rows. The one
// gap this closes: project-scoped memory rows carry envelope taskId null, so they'd match every
// task filter under a naive `=== null` admit; instead attribute them to their WRITING task via
// authorTaskId (payload.author.taskId), and admit only when that matches. An ownerless memory row
// (authorTaskId null — a human/cli global note) is admitted by NO task filter.
export function shouldAdmitLogRow(row: LogRow, taskFilter: string | null): boolean {
  if (taskFilter === null) return true
  if (row.taskId === taskFilter) return true
  if (row.taskId === null) return row.authorTaskId === taskFilter
  return false
}
