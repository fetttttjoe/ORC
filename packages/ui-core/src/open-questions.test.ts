import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, EVENT_KIND, type EventRecord } from '@orc/contracts'
import { TEST_WORKSPACE_ID, eventFixture } from '@orc/contracts/fixtures'
import { openQuestions } from './open-questions'

const ev = (seq: number, kind: EventRecord['kind'], taskId: string | null, payload: Record<string, unknown> = {}): EventRecord =>
  eventFixture({ seq, kind, taskId, payload })

const ask = (seq: number, task: string, topic: string, q = 'q?') => ev(seq, EVENT_KIND.feedback_requested, task, { question: q, topic })
// A reply carries a full MemoryAuthor — `workspaceId` is required on it, so a bare `{ source }`
// does not parse and the answer would silently fail to close its topic.
const answer = (seq: number, task: string, topic: string) =>
  ev(seq, EVENT_KIND.feedback_provided, task, { topic, text: 'a', author: { source: AUTHOR_SOURCE.human, workspaceId: TEST_WORKSPACE_ID } })
const never = () => false

describe('open questions', () => {
  // Keyed by (task, topic), which is what openFeedbackTopics keys on: a task can be parked on two
  // questions at once, and a task-only key retires both the moment either is answered.
  it('two topics on one task are two open questions', () => {
    expect(openQuestions([ask(1, 't', 'cwd'), ask(2, 't', 'scope')], never).map(q => q.topic)).toEqual(['cwd', 'scope'])
  })

  // Folded over the whole log rather than a tail window: an operator who let the feed run past a
  // question still has to answer it.
  it('a question 1000 events back is still open', () => {
    const noise = Array.from({ length: 1000 }, (_, i) => ev(i + 2, EVENT_KIND.tool_call, 't', { toolName: 'x', input: {} }))
    expect(openQuestions([ask(1, 't', 'cwd'), ...noise], never)).toHaveLength(1)
  })

  it('a re-ask after an answer is open again, carrying the newest wording', () => {
    const s = openQuestions([ask(1, 't', 'cwd', 'old'), answer(2, 't', 'cwd'), ask(3, 't', 'cwd', 'new')], never)
    expect(s).toEqual([{ taskId: 't', topic: 'cwd', stepId: null, question: 'new', seq: 3 }])
  })

  // The list is a queue: the question nobody has spoken to in longest sits at the top, and a re-ask
  // is a fresh ask that goes to the back. Insertion order cannot express that — a Map keeps a
  // re-asked key in its ORIGINAL position, so the re-ask would jump the queue it just joined.
  it('orders by the newest ask, so the longest-waiting question comes first', () => {
    const s = openQuestions([ask(1, 't', 'cwd', 'old'), ask(2, 't', 'scope'), answer(3, 't', 'cwd'), ask(4, 't', 'cwd', 'again')], never)
    expect(s.map(q => [q.topic, q.seq])).toEqual([['scope', 2], ['cwd', 4]])
  })

  it('a terminal task has no open question: it can no longer be answered', () => {
    expect(openQuestions([ask(1, 't', 'cwd')], id => id === 't')).toEqual([])
  })
})
