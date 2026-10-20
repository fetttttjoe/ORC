import { z } from 'zod'
import type { PlanStep } from './plan'
import { Author } from './author'
import { SLUG_ID_RE, SHA256_HEX_RE } from './ids'

export enum Confidence {
  high = 'high',
  medium = 'medium',
  low = 'low',
  none = 'none',
}

// analyzed and gaps are load-bearing; the other fields are reserved
export const CoverageReport = z.object({
  analyzed: z.boolean(),
  scope: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  confidence: z.enum(Confidence).default(Confidence.none),
  claimsWritten: z.number().int().nonnegative().default(0),
})
export type CoverageReport = z.infer<typeof CoverageReport>
export const AnalysisCompletedPayload = CoverageReport
export type AnalysisCompletedPayload = z.infer<typeof AnalysisCompletedPayload>

// topic is derived deterministically by the caller (replay-safe)
export const FeedbackRequestedPayload = z.object({
  noteId: z.string().regex(SLUG_ID_RE).optional(),
  question: z.string().min(1),
  topic: z.string().min(1),
})
export type FeedbackRequestedPayload = z.infer<typeof FeedbackRequestedPayload>
export const FeedbackProvidedPayload = z.object({
  topic: z.string().min(1),
  text: z.string(),
  author: Author,
  planHash: z.string().regex(SHA256_HEX_RE).optional(),
})
export type FeedbackProvidedPayload = z.infer<typeof FeedbackProvidedPayload>

// a human annotation is an input event; the plan re-renders from it
export const PlanAnnotatedPayload = z.object({
  planVersion: z.number().int().positive(),
  targetNote: z.string().regex(SLUG_ID_RE),
  refs: z.array(z.string().regex(SLUG_ID_RE)).default([]),
  text: z.string().min(1),
})
export type PlanAnnotatedPayload = z.infer<typeof PlanAnnotatedPayload>

// analysisStep() returns the analyze-phase step config
export interface Analyzer { id: string; analysisStep(opts: { modelRef: string; taskSpec: string }): PlanStep }
