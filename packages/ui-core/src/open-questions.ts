import { EVENT_KIND, PAYLOAD_SCHEMAS, feedbackKey, openFeedbackTopics, type EventRecord } from '@orc/contracts'
import type { OperatorState } from './wire'

// folded over the whole log: a window loses questions; the open rule stays in openFeedbackTopics

// derived from the wire schema: a renamed field fails the build here
type OpenQuestion = OperatorState['openQuestions'][number]

export function openQuestions(events: ReadonlyArray<EventRecord>, isTerminal: (taskId: string) => boolean): OpenQuestion[] {
  const asked = new Map<string, OpenQuestion>()

  for (const e of events) {
    if (e.kind !== EVENT_KIND.feedback_requested || e.taskId === null) continue
    // lenient: a payload that does not parse is not a question and must not wedge the task
    const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(e.payload)
    if (p.success)
      asked.set(feedbackKey(e.taskId, p.data.topic), { taskId: e.taskId, topic: p.data.topic, stepId: e.stepId, question: p.data.question, seq: e.seq })
  }

  const open = openFeedbackTopics(events)
  return [...asked]
    // a terminal task's question can no longer be answered, so it is withdrawn
    .filter(([key, q]) => open.has(key) && !isTerminal(q.taskId))
    .map(([, q]) => q)
    // oldest ask first: Map.set keeps a re-asked key in its original position, so sort
    .sort((a, b) => a.seq - b.seq)
}
