import { EVENT_KIND, foldKnowledgeWrites, KnowledgeWrittenPayload, type EventRecord, type KnowledgeWrites } from '@orc/contracts'

export function knowledgeWritesIn(events: readonly EventRecord[], taskIds: ReadonlySet<string>): KnowledgeWrites {
  const writes = events
    .filter(e => e.kind === EVENT_KIND.knowledge_written && e.taskId !== null && taskIds.has(e.taskId))
    .toSorted((a, b) => a.seq - b.seq)
    .flatMap(e => { const parsed = KnowledgeWrittenPayload.safeParse(e.payload); return parsed.success ? [parsed.data] : [] })
  return foldKnowledgeWrites(writes)
}
