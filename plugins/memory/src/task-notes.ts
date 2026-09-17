import { emptyMemoryFold, foldMemoryInto, NOTE_TIER, type DecisionStatus, type EventRecord, type NoteKind } from '@orc/contracts'

// What ONE task wrote into memory, recovered from the log — the finish step's starting list.
//
// Folds through contracts' mutation algebra (foldMemoryInto), never its own decode. The log already
// had two interpreters and they diverged once — the fold dropped memory_verified entirely and
// `orc memory recheck` reported 30 drifted against health's 29 on the same corpus at the same
// instant (see decodeMemoryEvent's comment and parity.test.ts). A third hand-rolled walk here would
// re-open that: archiving, for one, is a memory_written carrying archived: true, which only the
// shared decode splits out correctly.
//
// LAST WRITER WINS. `MemoryFold.notes` holds the latest write per note with ITS author, so a note
// this task wrote but another task has since rewritten or archived is not on this list: the text it
// reported is no longer what the note says, and the other task owns the current wording. That is not
// a technicality — the finish step's contract is to memory_read every row it gets back, and an
// archived note's row is DELETED from the read model, so leaving it listed hands the finisher a
// ghost id it cannot read and cannot reconcile. The task's OWN archive stays listed, flagged.
//
// MEASURED 2026-09-15: the store appends every memory event with `taskId: null` in the ENVELOPE
// (store.ts:64, :133) — the writing task lives on `payload.author.taskId`, put there by the step
// binding's author (runtime.ts:186). A fold keyed on the envelope returns nothing at all, and
// `log.byTask` cannot answer this question for the same reason.

export interface TaskNoteRow {
  id: string
  scope: string
  title: string
  summary: string
  // Semantic tier only, and `status` only where the note actually carries one: a `kind` on an
  // episodic step note would be invented, and MemoryNoteInput refuses `status` on anything but a
  // decision. Omitted rather than nulled so the finisher reads "this row says nothing about a
  // lifecycle" instead of "this note has no status".
  kind?: NoteKind
  status?: DecisionStatus
  archived: boolean
}

/**
 * Every live note whose LATEST write was authored by `taskId`, ordered by [scope, id] — stable, and
 * it groups the task's plan lane away from durable project knowledge. A note anyone deleted is gone
 * (the fold drops it); an event whose payload does not parse costs that one event and nothing else.
 */
export function notesWrittenBy(
  events: ReadonlyArray<Pick<EventRecord, 'kind' | 'payload'>>,
  taskId: string,
): TaskNoteRow[] {
  return [...events.reduce(foldMemoryInto, emptyMemoryFold()).notes.values()]
    .filter(w => w.author.taskId === taskId)
    .map(({ note }) => {
      const semantic = note.tier === NOTE_TIER.semantic
      return {
        id: note.id, scope: note.scope, title: note.title, summary: note.summary,
        ...(semantic && { kind: note.kind }),
        ...(semantic && note.status !== undefined && { status: note.status }),
        archived: note.archived,
      }
    })
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
}
