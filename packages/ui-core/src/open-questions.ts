import { EVENT_KIND, PAYLOAD_SCHEMAS, feedbackKey, openFeedbackTopics, type EventRecord } from '@orc/contracts'
import type { OperatorState } from './wire'

// Every question still owed an answer, with the wording an operator has to read, folded over the
// WHOLE log.
//
// Whole log because a window loses questions: folded from the 150-row seed a feed opens with, every
// question older than that page is gone and never comes back — a task parked waiting for a human
// reads as idle, the one state that tells an operator to look elsewhere. Keyed by (task, topic)
// because a task can be parked on two questions at once, and a task-only key retires both the
// moment either is answered.
//
// WHICH (task, topic) pairs are still open is openFeedbackTopics' rule and stays there: the reply
// path resolves a topic against that same function, and a second add/delete spelling here would let
// the question an operator sees and the topic a reply closes drift apart with nothing to report it.
// This file adds only what that rule does not carry — the newest ask's wording, its step and its
// seq. So the walk below never deletes: it indexes asks, and the rule decides which survive.
//
// The events are the only place those three live, which is why this is a log fold at all. Anything
// about a task that State already holds belongs to a State predicate at the call site, not here.
//
// `question` is the payload's own text, never a summarized row: a summary line prefixes it with
// `Q: `, collapses its whitespace and clips it at 120 characters — silently truncating the one
// thing a human is being asked to read.
//
// Ceiling: O(events), re-run per appended event because the view carrying this is pushed rather
// than refetched. Measured over a synthetic 1012-event log, including the second walk
// openFeedbackTopics does: 0.007–0.02 ms per whole fold, the spread being JIT warm-up across runs.
// So a refold per append is not worth avoiding, and one copy of the open-ness rule is worth the
// second walk. Past the size where that stops holding, the upgrade is an incremental accumulator
// beside `foldInto`, advanced by one event rather than rebuilt.

// Derived from the wire schema rather than re-declared: the fold builds exactly what the browser
// parses, so a renamed field fails the build here instead of arriving as an entry nothing renders.
type OpenQuestion = OperatorState['openQuestions'][number]

export function openQuestions(events: ReadonlyArray<EventRecord>, isTerminal: (taskId: string) => boolean): OpenQuestion[] {
  const asked = new Map<string, OpenQuestion>()

  for (const e of events) {
    if (e.kind !== EVENT_KIND.feedback_requested || e.taskId === null) continue
    // lenient like every fold here: a payload that does not parse is not a question, and must not
    // present itself as an open gate and wedge the task
    const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(e.payload)
    if (p.success)
      asked.set(feedbackKey(e.taskId, p.data.topic), { taskId: e.taskId, topic: p.data.topic, stepId: e.stepId, question: p.data.question, seq: e.seq })
  }

  const open = openFeedbackTopics(events)
  return [...asked]
    // A terminal task's question can no longer be answered — the run that would receive the reply
    // is gone — so it is withdrawn rather than left for an operator to act on.
    .filter(([key, q]) => open.has(key) && !isTerminal(q.taskId))
    .map(([, q]) => q)
    // A queue, oldest ask first. Sorted rather than left in insertion order because `Map.set` keeps
    // a re-asked key in its ORIGINAL position, which would let a question just re-asked sit above
    // one nobody has spoken to since.
    .sort((a, b) => a.seq - b.seq)
}
