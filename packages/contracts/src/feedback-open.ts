import { EVENT_KIND } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import type { EventRecord } from './event-kinds'
import { feedbackKey } from './feedback-key'

export { feedbackKey }

// the one rule for 'is this question still open?'; imports vocabulary, never a capability

// narrower than EventRecord: the rule is order-based, not seq-based
export type FeedbackEvent = Pick<EventRecord, 'taskId' | 'kind' | 'payload'>

// add on ask, delete on answer, in log order; an unparseable event is never an open gate
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
