import { describe, expect, it } from 'bun:test'
import { EVENT_KIND } from './event-kinds'
import { feedbackKey, openFeedbackTopics, type FeedbackEvent } from './feedback-open'
import { authorFixture } from './fixtures'

// a table: both consumers read this one rule and neither's tests cover every case
const ask = (taskId: string | null, topic: string): FeedbackEvent =>
  ({ taskId, kind: EVENT_KIND.feedback_requested, payload: { topic, question: `${topic}?` } })
const answer = (taskId: string | null, topic: string): FeedbackEvent =>
  ({ taskId, kind: EVENT_KIND.feedback_provided, payload: { topic, text: 'yes', author: authorFixture() } })

const CASES: Array<{ name: string; events: FeedbackEvent[]; open: string[] }> = [
  { name: 'asked → open', events: [ask('t1', 'cwd')], open: [feedbackKey('t1', 'cwd')] },
  { name: 'asked then answered → closed', events: [ask('t1', 'cwd'), answer('t1', 'cwd')], open: [] },
  {
    // a 'has ever been answered' spelling gets this wrong
    name: 're-asked after an answer → open again',
    events: [ask('t1', 'cwd'), answer('t1', 'cwd'), ask('t1', 'cwd')],
    open: [feedbackKey('t1', 'cwd')],
  },
  {
    // a 'count asks minus answers' spelling gets this wrong
    name: 'two asks, one answer → closed',
    events: [ask('t1', 'cwd'), ask('t1', 'cwd'), answer('t1', 'cwd')],
    open: [],
  },
  {
    // a topic is unique per TASK, not per project — answering t1's `cwd` leaves t2's untouched
    name: 'the same topic on another task is another question',
    events: [ask('t1', 'cwd'), ask('t2', 'cwd'), answer('t1', 'cwd')],
    open: [feedbackKey('t2', 'cwd')],
  },
  {
    name: 'an answer on another topic closes nothing',
    events: [ask('t1', 'cwd'), answer('t1', 'model')],
    open: [feedbackKey('t1', 'cwd')],
  },
  {
    // lenient: a poison event is neither a gate nobody can open nor a silent close
    name: 'a malformed payload is neither an ask nor an answer',
    events: [
      { taskId: 't1', kind: EVENT_KIND.feedback_requested, payload: { question: 'no topic' } },
      ask('t2', 'cwd'),
      { taskId: 't2', kind: EVENT_KIND.feedback_provided, payload: { text: 'no topic' } },
    ],
    open: [feedbackKey('t2', 'cwd')],
  },
  {
    // project-level events carry taskId: null and belong to no question anyone could answer
    name: 'an event with no task is not a question',
    events: [ask(null, 'cwd')],
    open: [],
  },
]

describe('openFeedbackTopics', () => {
  for (const c of CASES)
    it(c.name, () => {
      expect([...openFeedbackTopics(c.events)].sort()).toEqual([...c.open].sort())
    })

  it('keys a question by task AND topic, so two tasks asking the same thing never collide', () => {
    expect(feedbackKey('t1', 'cwd')).not.toBe(feedbackKey('t2', 'cwd'))
  })
})
