import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, EVENT_KIND, type EventRecord } from '@orc/contracts'
import { authorFixture, eventFixture } from '@orc/contracts/fixtures'
import { openQuestions } from './open-questions'

const ev = (seq: number, kind: EventRecord['kind'], taskId: string | null, payload: Record<string, unknown> = {}): EventRecord =>
  eventFixture({ seq, kind, taskId, payload })

const ask = (seq: number, task: string, topic: string, q = 'q?') => ev(seq, EVENT_KIND.feedback_requested, task, { question: q, topic })
// a reply carries a full Author: a bare { source } does not parse and would not close its topic
const answer = (seq: number, task: string, topic: string) =>
  ev(seq, EVENT_KIND.feedback_provided, task, { topic, text: 'a', author: authorFixture({ source: AUTHOR_SOURCE.human }) })
const never = () => false

describe('open questions', () => {
  it('two topics on one task are two open questions', () => {
    expect(openQuestions([ask(1, 't', 'cwd'), ask(2, 't', 'scope')], never).map(q => q.topic)).toEqual(['cwd', 'scope'])
  })

  it('a question 1000 events back is still open', () => {
    const noise = Array.from({ length: 1000 }, (_, i) => ev(i + 2, EVENT_KIND.tool_call, 't', { toolName: 'x', input: {} }))
    expect(openQuestions([ask(1, 't', 'cwd'), ...noise], never)).toHaveLength(1)
  })

  it('a re-ask after an answer is open again, carrying the newest wording', () => {
    const s = openQuestions([ask(1, 't', 'cwd', 'old'), answer(2, 't', 'cwd'), ask(3, 't', 'cwd', 'new')], never)
    expect(s).toEqual([{ taskId: 't', topic: 'cwd', stepId: null, question: 'new', seq: 3 }])
  })

  // a queue: a re-ask goes to the back; a Map keeps a re-asked key in its original position
  it('orders by the newest ask, so the longest-waiting question comes first', () => {
    const s = openQuestions([ask(1, 't', 'cwd', 'old'), ask(2, 't', 'scope'), answer(3, 't', 'cwd'), ask(4, 't', 'cwd', 'again')], never)
    expect(s.map(q => [q.topic, q.seq])).toEqual([['scope', 2], ['cwd', 4]])
  })

  it('a terminal task has no open question: it can no longer be answered', () => {
    expect(openQuestions([ask(1, 't', 'cwd')], id => id === 't')).toEqual([])
  })
})
