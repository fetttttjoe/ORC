import { EVENT_KIND, type EventRecord } from '@orc/contracts'

export interface LogRow {
  seq: number
  ts: string
  kind: string
  taskId: string | null
  stepId: string | null
  line: string
  noteRef: string | null // `note:<scope>\u0000<id>` for memory events — lets log rows link without string-parsing
}

const snip = (v: unknown, n = 140): string => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// One line per event — shared by the web log view, debug-tail, and any future TUI feed.
export function summarizeEvent(e: EventRecord): LogRow {
  const p = e.payload as Record<string, any>
  let line: string
  let noteRef: string | null = null
  switch (e.kind) {
    case EVENT_KIND.step_started: line = `attempt ${p.attempt}`; break
    case EVENT_KIND.agent_call: {
      const r = (p.response ?? {}) as { text?: string; toolCalls?: Array<{ toolName: string }> }
      const calls = (r.toolCalls ?? []).map(c => c.toolName).join(',')
      line = `iter ${p.iteration}  ${r.text ? `"${snip(r.text, 110)}"` : ''}${calls ? `  →calls[${calls}]` : ''}`
      break
    }
    case EVENT_KIND.tool_call: line = `${p.toolName}(${snip(p.input, 110)})`; break
    case EVENT_KIND.tool_result: line = `${p.toolName} ${p.isError ? 'ERROR ' : ''}${snip(p.output, 110)}`; break
    case EVENT_KIND.memory_written: {
      const nt = (p.note ?? {}) as { id?: string; scope?: string; kind?: string; links?: unknown[]; sources?: unknown[] }
      line = `${nt.id} kind=${nt.kind ?? 'fact'} links=${(nt.links ?? []).length} sources=${(nt.sources ?? []).length}`
      noteRef = nt.id ? `note:${nt.scope ?? 'project'}\u0000${nt.id}` : null
      break
    }
    case EVENT_KIND.memory_deleted:
      line = `${p.id}`
      noteRef = p.id ? `note:${p.scope ?? 'project'}\u0000${p.id}` : null
      break
    case EVENT_KIND.memory_accessed:
      line = `${p.id} ${p.mode}`
      noteRef = p.id ? `note:${p.scope ?? 'project'}\u0000${p.id}` : null
      break
    case EVENT_KIND.signal_received: line = `${p.signal?.outcome ?? ''}: ${snip(p.signal?.summary, 90)}`; break
    case EVENT_KIND.step_completed: line = `→ ${snip(p.summary, 120)}`; break
    case EVENT_KIND.step_failed: line = `[${p.class}] ${snip(p.message, 120)}`; break
    case EVENT_KIND.feedback_requested: line = `Q: ${snip(p.question, 120)}`; break
    case EVENT_KIND.feedback_provided: line = `A: ${snip(p.text, 120)}`; break
    case EVENT_KIND.artifact_produced: line = `${p.path} sha256:${String(p.sha256 ?? '').slice(0, 12)} ${p.size}B`; break
    case EVENT_KIND.task_status_changed: line = `${p.from ?? '?'} → ${p.to}`; break
    case EVENT_KIND.operation_started: case EVENT_KIND.operation_completed: case EVENT_KIND.operation_failed:
      line = `${p.kind ?? ''} ${p.name ?? ''}`; break
    default: line = snip(p, 90)
  }
  return { seq: e.seq, ts: e.ts, kind: e.kind, taskId: e.taskId, stepId: e.stepId, line, noteRef }
}
