import { z } from 'zod'
import type { PlanStep } from './plan'
import { MEMORY_ID_RE, MemoryAuthor } from './memory'

// analyzed+gaps are load-bearing (RG7 degradation, RG3 uncertainty). scope/confidence/notesWritten
// are reserved forward-looking (cbm epistemics ideas #2/#7 + future hot-paths/churn telemetry).
export const CoverageReport = z.object({
  analyzed: z.boolean(),
  scope: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low', 'none']).default('none'),
  notesWritten: z.number().int().nonnegative().default(0),
})
export type CoverageReport = z.infer<typeof CoverageReport>
export const AnalysisCompletedPayload = CoverageReport
export type AnalysisCompletedPayload = z.infer<typeof AnalysisCompletedPayload>

// D4 conversational gate. topic is deterministically derived by the caller (replay-safe).
export const FeedbackRequestedPayload = z.object({
  noteId: z.string().regex(MEMORY_ID_RE).optional(),
  question: z.string().min(1),
  topic: z.string().min(1),
})
export type FeedbackRequestedPayload = z.infer<typeof FeedbackRequestedPayload>
export const FeedbackProvidedPayload = z.object({
  topic: z.string().min(1),
  text: z.string(),
  author: MemoryAuthor,
  planHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
export type FeedbackProvidedPayload = z.infer<typeof FeedbackProvidedPayload>

// D5 human annotation on a plan-note — an input event; the plan re-renders from it.
export const PlanAnnotatedPayload = z.object({
  planVersion: z.number().int().positive(),
  targetNote: z.string().regex(MEMORY_ID_RE),
  refs: z.array(z.string().regex(MEMORY_ID_RE)).default([]),
  text: z.string().min(1),
})
export type PlanAnnotatedPayload = z.infer<typeof PlanAnnotatedPayload>

// D2 analyzer seam (Amendment A): analysisStep() returns the analyze-phase step config.
// agent-analyzer returns a codebase-analysis scout step; ast-analyzer returns its own later.
export interface Analyzer { id: string; analysisStep(opts: { modelRef: string; taskSpec: string }): PlanStep }
