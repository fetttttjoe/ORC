import { EVENT_KIND } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import type { EventRecord } from './event-kinds'
import { feedbackKey } from './feedback-key'

// re-exported so every existing importer of feedbackKey from here (or from the bare package
// entry point, which re-exports this whole file) keeps compiling unchanged
export { feedbackKey }

// The ONE rule for "is this question still open?", and nothing else.
//
// Two surfaces used to answer it independently and could not be shown to agree: the kernel picked
// the latest `feedback_requested` with no LATER-seq answer on its topic, and the workspace health
// rung folded add-on-ask / delete-on-answer over log-ordered events. Both reached the same verdict,
// but only by argument — the second spelling was a comment claiming equivalence, and a comment
// cannot be run. Either one drifting turns a task parked in DBOS.recv into a workspace that reads
// `idle`, which is the one state that tells an operator to look elsewhere.
//
// Pure: no log, no db, no clock, no transaction — it takes the events it
// is given and returns a value. It is NOT import-free, and deliberately so: the kinds and the
// payload shapes are project vocabulary, and hand-spelling 'feedback_requested' or reading `.topic`
// off an untyped payload here would break the two rules that outrank file purity in this repo (all
// parsing through zod; no scattered string literals). What it imports is the vocabulary, never a
// capability.

// The only shape this rule reads. Narrower than EventRecord so a caller can answer it from a
// health-table fixture that carries no `seq` — the rule is ORDER-based, not seq-based, and taking
// seq would let a caller think it could pass events out of log order.
export type FeedbackEvent = Pick<EventRecord, 'taskId' | 'kind' | 'payload'>

/**
 * Every (task, topic) still owed an answer, from events in LOG ORDER.
 *
 * Add on ask, delete on answer. That is the whole rule, and it is why order matters rather than
 * seq: a re-ask after an answer re-opens the topic (the ask is last), and two asks answered once are
 * closed (one key, one delete) — the two cases a "has ever asked" or "count asks minus answers"
 * spelling gets wrong in opposite directions.
 *
 * An event with no task belongs to no question anyone can answer, and a payload that does not parse
 * is not a question either — lenient like every other fold here, because a poison event must not
 * present itself as an open gate and wedge a task forever.
 */
export function openFeedbackTopics(events: ReadonlyArray<FeedbackEvent>): Set<string> {
  const open = new Set<string>()
  for (const e of events) {
    if (e.taskId === null) continue
    if (e.kind === EVENT_KIND.feedback_requested) {
      const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(e.payload)
      if (p.success) open.add(feedbackKey(e.taskId, p.data.topic))
    } else if (e.kind === EVENT_KIND.feedback_provided) {
      const p = PAYLOAD_SCHEMAS.feedback_provided.safeParse(e.payload)
      if (p.success) open.delete(feedbackKey(e.taskId, p.data.topic))
    }
  }
  return open
}
