import { foldLiveNotes, noteKey, type EventRecord } from '@orc/contracts'

export interface SweptNote { id: string; scope: string; title: string; summary: string }

// Deterministic cancel-time GC — the orchestrator decides what stays vs goes, not an agent.
// A note GOES iff its LAST writer's task is in `cancelled` AND no surviving note links to it.
// Adopted ids (re-written by a live writer) stay; cli/null-authored notes are never swept.
// Deletion is a memory_deleted event, so content stays in the log for audit/replay.
export function orphanedNotes(events: EventRecord[], cancelled: Set<string>): SweptNote[] {
  const notes = [...foldLiveNotes(events).values()].map(({ note, author }) => ({
    scope: note.scope, id: note.id, title: note.title, summary: note.summary,
    links: note.links.map(l => l.id), taskId: author.taskId ?? '',
  }))
  const referenced = new Set(
    notes.filter(n => !cancelled.has(n.taskId)).flatMap(n => n.links.map(id => noteKey(n.scope, id))),
  )
  return notes
    .filter(n => cancelled.has(n.taskId) && !referenced.has(noteKey(n.scope, n.id)))
    .map(({ id, scope, title, summary }) => ({ id, scope, title, summary }))
}
