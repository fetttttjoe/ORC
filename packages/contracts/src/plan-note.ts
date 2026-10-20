import { z } from 'zod'
import { SLUG_ID_RE } from './ids'

export const PLAN_NOTE_LIMITS = {
  labelChars: 64,
  detailItems: 100,
  detailChars: 1_000,
  titleChars: 200,
  summaryChars: 500,
  bodyChars: 100_000,
  rationaleChars: 20_000,
} as const

export enum PlanNoteToolName { write = 'plan_note_write', read = 'plan_note_read', finalize = 'finalize_plan' }

const RefList = z.array(z.string().min(1).max(PLAN_NOTE_LIMITS.labelChars)).max(16)

export const PlanNote = z.object({
  id: z.string().regex(SLUG_ID_RE).max(128),
  title: z.string().min(1).max(PLAN_NOTE_LIMITS.titleChars),
  summary: z.string().max(PLAN_NOTE_LIMITS.summaryChars),
  body: z.string().max(PLAN_NOTE_LIMITS.bodyChars),
  rationale: z.string().max(PLAN_NOTE_LIMITS.rationaleChars),
  uncertainty: z.array(z.string().max(PLAN_NOTE_LIMITS.detailChars)).max(PLAN_NOTE_LIMITS.detailItems),
  dependsOn: z.array(z.string().min(1).max(PLAN_NOTE_LIMITS.labelChars)).max(PLAN_NOTE_LIMITS.detailItems),
  zone: z.array(z.string().min(1).max(PLAN_NOTE_LIMITS.detailChars)).max(16),
  skillRefs: RefList,
  toolRefs: RefList,
  modelRef: z.string().max(PLAN_NOTE_LIMITS.labelChars),
  subplans: z.array(z.string().regex(SLUG_ID_RE).max(128)).max(PLAN_NOTE_LIMITS.detailItems),
})
export type PlanNote = z.infer<typeof PlanNote>

export const PlanNoteWrite = PlanNote.partial().required({ id: true })
export type PlanNoteWrite = z.infer<typeof PlanNoteWrite>

export const PlanNoteWrittenPayload = z.object({ note: PlanNote })
export type PlanNoteWrittenPayload = z.infer<typeof PlanNoteWrittenPayload>
