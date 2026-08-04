import { NOTE_TIER, RETENTION, foldMemory, noteKey, type EventRecord, type MemoryFold, type NoteTier } from '@orc/contracts'

export interface SweptNote { id: string; scope: string; title: string; summary: string }

// A live note reduced to what a sweep policy needs: its address, what the dry-run report shows,
// and its outbound links — which are what make it a PROTECTOR of the notes it points at.
interface LiveNote extends SweptNote { links: string[]; taskId: string; tier: NoteTier }

const liveNotes = (m: MemoryFold): LiveNote[] =>
  [...m.notes.values()].map(({ note, author }) => ({
    id: note.id, scope: note.scope, title: note.title, summary: note.summary,
    links: note.links.map(l => l.id), taskId: author.taskId ?? '', tier: note.tier,
  }))

// The one topology rule every sweep obeys (docs/IDEAS.md entry 1, design fix 3): a candidate
// survives if any note that ITSELF survives authored a link to it. Traffic is deliberately not
// consulted — three live notes can point at a candidate nobody has walked, and deleting it leaves
// their links[] dangling at a dead id, which nothing repairs (rewriting authored links is a
// non-goal). Candidates linking only to each other protect nobody: they all go together.
function unreferenced<T extends LiveNote>(all: LiveNote[], going: T[]): T[] {
  const doomed = new Set(going.map(n => noteKey(n.scope, n.id)))
  const referenced = new Set(
    all.filter(n => !doomed.has(noteKey(n.scope, n.id)))
      .flatMap(n => n.links.map(id => noteKey(n.scope, id))),
  )
  return going.filter(n => !referenced.has(noteKey(n.scope, n.id)))
}

// Deterministic cancel-time GC — the orchestrator decides what stays vs goes, not an agent.
//
// This file used to also hold a TTL sweep (staleNotes, DEFAULT_SWEEP_DAYS): retirement after N
// untouched days. It was deleted with `orc memory sweep` because elapsed time is the wrong axis —
// a config note is correct for years, read rarely and never changes, so a TTL retires exactly the
// notes most worth keeping. Retirement is now decided from EVIDENCE of obsolescence in archive.ts,
// and it ARCHIVES rather than deletes. Only this cancel-time collection remains here, because it
// keys off a fact (the writing task was cancelled), not a clock.
// A note GOES iff its LAST writer's task is in `cancelled` AND no surviving note links to it.
// Adopted ids (re-written by a live writer) stay; cli/null-authored notes are never swept.
// Deletion is a memory_deleted event, so content stays in the log for audit/replay.
export function orphanedNotes(events: EventRecord[], cancelled: Set<string>): SweptNote[] {
  const all = liveNotes(foldMemory(events))
  const going = unreferenced(all, all.filter(n => cancelled.has(n.taskId)))
  return going.map(({ id, scope, title, summary }) => ({ id, scope, title, summary }))
}
