import { EVENT_KIND, PlanNote, PlanNoteWrittenPayload, errorMessage, planFieldViolations, type EventRecord, type PlanNoteWrite } from '@orc/contracts'

const EMPTY_PLAN_NOTE = {
  summary: '', body: '', rationale: '', uncertainty: [], dependsOn: [], zone: [], skillRefs: [], toolRefs: [], modelRef: '', subplans: [],
} satisfies Omit<PlanNote, 'id' | 'title'>

function* writtenNotes(events: ReadonlyArray<EventRecord>, taskId: string): Generator<{ seq: number; note: PlanNote }> {
  for (const e of events) {
    if (e.kind !== EVENT_KIND.plan_note_written || e.taskId !== taskId) continue
    const p = PlanNoteWrittenPayload.safeParse(e.payload)
    if (p.success) yield { seq: e.seq, note: p.data.note }
  }
}

// events in seq order; the latest write per id wins, in first-write order
export function planNotesOf(events: ReadonlyArray<EventRecord>, taskId: string): PlanNote[] {
  const byId = new Map<string, PlanNote>()
  for (const { note } of writtenNotes(events, taskId)) byId.set(note.id, note)
  return [...byId.values()]
}

export function planNotesWrittenAfter(events: ReadonlyArray<EventRecord>, taskId: string, seq: number): string[] {
  const ids = new Set<string>()
  for (const w of writtenNotes(events, taskId)) if (w.seq > seq) ids.add(w.note.id)
  return [...ids]
}

export enum PlanNoteRefusal { untitled = 'untitled', shape = 'shape' }
export type PlanNoteRefused = { refusal: string; code: PlanNoteRefusal }

export function mergePlanNote(prev: PlanNote | undefined, write: PlanNoteWrite): PlanNote | PlanNoteRefused {
  if (prev === undefined && write.title === undefined)
    return { refusal: `plan note '${write.id}' is new, so it needs a title`, code: PlanNoteRefusal.untitled }
  const defined = Object.fromEntries(Object.entries(write).filter(([, v]) => v !== undefined))
  const merged = PlanNote.safeParse({ ...EMPTY_PLAN_NOTE, ...prev, ...defined })
  if (!merged.success) return { refusal: `plan note '${write.id}': ${errorMessage(merged.error)}`, code: PlanNoteRefusal.shape }
  const shape = planFieldViolations({ id: merged.data.id, zone: merged.data.zone }).shape[0]
  return shape === undefined ? merged.data : { refusal: shape, code: PlanNoteRefusal.shape }
}
