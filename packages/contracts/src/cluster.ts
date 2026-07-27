import { z } from 'zod'
import { CLAIM_ID_RE } from './claim'
import { MemoryAuthor } from './ids'
import { MEMORY_LIMITS } from './limits'

// A derived group of claims as a reader receives it. `topicKey` is a claim id — a content hash — so it
// is reproducible from the group's members rather than being a positional index, and it validates
// against CLAIM_ID_RE for the same reason every other claim id does: one spelling of the shape, so a
// malformed key fails as a shape error instead of as a mysterious "no such topic". `label` is an
// INDEX ENTRY derived from the medoid claim (cluster.ts topicLabel): its opening words, cut at a
// word boundary and elided, so one topic reads as one scannable row. It is a verbatim prefix, never
// a paraphrase — the full sentence and the topic's other claims come from topicClaims(topicKey)
// (`memory_topics <topicKey>`, `orc memory topics <topicKey>`), which is the ONE place detail lives.
//
// Bounded HERE, so a read model that somehow holds a full sentence fails as a shape error at the
// boundary rather than silently overflowing every listing. The read model is disposable — stage 3
// is recomputed wholesale by refreshTopics on every drain — so a `topic` row projected before this
// bound existed is corrected by the next refresh (or by `orc memory rebuild`), which is why
// tightening it here is safe in a way that tightening an EVENT bound never is: see
// MemoryTopicAccessedPayload below.
export const Topic = z.object({
  topicKey: z.string().regex(CLAIM_ID_RE),
  label: z.string().max(MEMORY_LIMITS.topicLabelChars),
  size: z.number().int().positive(),
})
export type Topic = z.infer<typeof Topic>

// Fetching one topic is the tracked signal this design is calibrated from. The label rides the event
// because the read model is disposable and a topic's label changes as the corpus does — a counter or a
// name that a rebuild erases is not a measurement.
//
// `label` here is DELIBERATELY unbounded, unlike Topic.label above. The event log is not disposable:
// this schema is re-parsed on every replay, and every memory_topic_accessed already in the log
// carries the full medoid sentence that was the label at the time. A .max() here would make those
// events fail to parse and vanish from every fold — the calibration signal this design is measured
// from, destroyed to tidy a field nobody renders. Same rule limits.ts states for bodyChars: a bound
// applied when re-reading history can only ever be loosened.
export const MemoryTopicAccessedPayload = z.object({
  topicKey: z.string().regex(CLAIM_ID_RE),
  label: z.string(),
  author: MemoryAuthor,
})
export type MemoryTopicAccessedPayload = z.infer<typeof MemoryTopicAccessedPayload>
