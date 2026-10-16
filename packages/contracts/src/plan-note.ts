import { z } from 'zod'
import { MEMORY_ID_RE } from './ids'
import { MEMORY_LIMITS } from './limits'

export enum PlanNoteToolName { write = 'plan_note_write', read = 'plan_note_read', finalize = 'finalize_plan' }

const RefList = z.array(z.string().min(1).max(MEMORY_LIMITS.labelChars)).max(16)

export const PlanNote = z.object({
  id: z.string().regex(MEMORY_ID_RE).max(128),
  title: z.string().min(1).max(MEMORY_LIMITS.titleChars),
  summary: z.string().max(MEMORY_LIMITS.summaryChars),
  body: z.string().max(MEMORY_LIMITS.bodyChars),
  rationale: z.string().max(MEMORY_LIMITS.rationaleChars),
  uncertainty: z.array(z.string().max(MEMORY_LIMITS.detailChars)).max(MEMORY_LIMITS.detailItems),
  dependsOn: z.array(z.string().min(1).max(MEMORY_LIMITS.labelChars)).max(MEMORY_LIMITS.detailItems),
  zone: z.array(z.string().min(1).max(MEMORY_LIMITS.detailChars)).max(16),
  skillRefs: RefList,
  toolRefs: RefList,
  modelRef: z.string().max(MEMORY_LIMITS.labelChars),
  subplans: z.array(z.string().regex(MEMORY_ID_RE).max(128)).max(MEMORY_LIMITS.detailItems),
})
export type PlanNote = z.infer<typeof PlanNote>

export const PlanNoteWrite = PlanNote.partial().required({ id: true })
export type PlanNoteWrite = z.infer<typeof PlanNoteWrite>

export const PlanNoteWrittenPayload = z.object({ note: PlanNote })
export type PlanNoteWrittenPayload = z.infer<typeof PlanNoteWrittenPayload>
