import { z } from 'zod'
import { CLAIM_ID_RE } from './claim'
import { MemoryAuthor } from './ids'

// A derived group of claims as a reader receives it. `topicKey` is a claim id — a content hash — so it
// is reproducible from the group's members rather than being a positional index, and it validates
// against CLAIM_ID_RE for the same reason every other claim id does: one spelling of the shape, so a
// malformed key fails as a shape error instead of as a mysterious "no such topic". `label` is the
// medoid claim's own text: every claim is already a standalone sentence, so the label is a real fact
// rather than a generated guess.
export const Topic = z.object({
  topicKey: z.string().regex(CLAIM_ID_RE),
  label: z.string(),
  size: z.number().int().positive(),
})
export type Topic = z.infer<typeof Topic>

// Fetching one topic is the tracked signal this design is calibrated from. The label rides the event
// because the read model is disposable and a topic's label changes as the corpus does — a counter or a
// name that a rebuild erases is not a measurement.
export const MemoryTopicAccessedPayload = z.object({
  topicKey: z.string().regex(CLAIM_ID_RE),
  label: z.string(),
  author: MemoryAuthor,
})
export type MemoryTopicAccessedPayload = z.infer<typeof MemoryTopicAccessedPayload>
