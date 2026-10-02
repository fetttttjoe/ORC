import path from 'node:path'
import { z } from 'zod'
import { CheckVerdict, EVENT_KIND, FS_READ_TOOL_NAME, normalizeRelPath, PAYLOAD_SCHEMAS } from '@orc/contracts'
import { EvidenceKind, type EvidenceEvent } from './evidence'

export const BASIS_EVIDENCE_KINDS = [EVENT_KIND.knowledge_written, EVENT_KIND.knowledge_checked] as const
export const ALL_EVIDENCE_KINDS = [...BASIS_EVIDENCE_KINDS, EVENT_KIND.knowledge_delivered, EVENT_KIND.tool_call] as const

export interface EvidenceRecord { seq: number; kind: string; runToken: string | null; payload: unknown }

const ReadInput = z.object({ path: z.string() })

const readPath = (raw: string): string => normalizeRelPath(path.posix.normalize(raw))

function eventsOf(record: EvidenceRecord): EvidenceEvent[] {
  const { seq, runToken: run, payload } = record
  switch (record.kind) {
    case EVENT_KIND.knowledge_written: {
      const p = PAYLOAD_SCHEMAS.knowledge_written.safeParse(payload)
      if (!p.success) return []
      return [
        ...p.data.asserted.map((a): EvidenceEvent => ({ kind: EvidenceKind.asserted, seq, run, id: a.id, text: a.text, anchors: a.anchors })),
        ...p.data.retired.map((r): EvidenceEvent => ({ kind: EvidenceKind.retired, seq, run, id: r.id })),
      ]
    }
    case EVENT_KIND.knowledge_checked: {
      const p = PAYLOAD_SCHEMAS.knowledge_checked.safeParse(payload)
      if (!p.success) return []
      const { id, text, verdict, anchors } = p.data
      return [{ kind: EvidenceKind.checked, seq, run, id, text, verdict, accepts: verdict === CheckVerdict.holds, anchors }]
    }
    case EVENT_KIND.knowledge_delivered: {
      const p = PAYLOAD_SCHEMAS.knowledge_delivered.safeParse(payload)
      return p.success ? [{ kind: EvidenceKind.delivered, seq, run, ids: p.data.ids, mode: p.data.mode }] : []
    }
    case EVENT_KIND.tool_call: {
      const p = PAYLOAD_SCHEMAS.tool_call.safeParse(payload)
      if (!p.success || p.data.toolName !== FS_READ_TOOL_NAME) return []
      const input = ReadInput.safeParse(p.data.input)
      return input.success ? [{ kind: EvidenceKind.read, seq, run, path: readPath(input.data.path) }] : []
    }
    default:
      return []
  }
}

export function evidenceEventsOf(records: readonly EvidenceRecord[]): EvidenceEvent[] {
  return records.flatMap(eventsOf)
}
