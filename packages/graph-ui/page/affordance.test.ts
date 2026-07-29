import { describe, expect, it } from 'bun:test'
import { APPROVAL_ANSWER, STEP_ID, isApprovalAnswer } from '@orc/contracts'
import { REPLY_AFFORDANCE, isApprovalGate, replyAffordance, replyReceipt } from './affordance'

describe('replyAffordance', () => {
  it('offers the answer box when this UI may answer for the project', () => {
    expect(replyAffordance(true, 't1')).toEqual({ kind: REPLY_AFFORDANCE.box })
  })

  it('offers the command when it may not — a question with no route to answering it is a dead end', () => {
    expect(replyAffordance(false, 't1'))
      .toEqual({ kind: REPLY_AFFORDANCE.command, cmd: 'orc reply t1 "<your answer>"' })
  })

  // A terminal task can never resume, so its still-open question must render as inert history —
  // no live box, no dead command. The status check runs BEFORE the canAnswer branch, so a
  // terminal status wins regardless of whether this UI could otherwise answer.
  it('closes the question on a terminal task instead of offering the box — answering it resumes nothing', () => {
    for (const status of ['cancelled', 'done', 'failed'] as const) {
      expect(replyAffordance(true, 't1', status)).toEqual({ kind: REPLY_AFFORDANCE.closed, status })
    }
  })

  it('closes the question on a terminal task even when this UI cannot answer — terminal wins over capability', () => {
    for (const status of ['cancelled', 'done', 'failed'] as const) {
      expect(replyAffordance(false, 't1', status)).toEqual({ kind: REPLY_AFFORDANCE.closed, status })
    }
  })

  it('is unchanged for a live task or when status is omitted — still the answer box', () => {
    expect(replyAffordance(true, 't1', 'running')).toEqual({ kind: REPLY_AFFORDANCE.box })
    expect(replyAffordance(true, 't1')).toEqual({ kind: REPLY_AFFORDANCE.box })
  })

  it('is unchanged for a live task on the command path — still the command', () => {
    expect(replyAffordance(false, 't1', 'running'))
      .toEqual({ kind: REPLY_AFFORDANCE.command, cmd: 'orc reply t1 "<your answer>"' })
  })
})

// A foreign project's question can now be answered from here, and the answer may land in a project
// with nothing running behind it. That is durable, not lost — but silence would let the user believe
// the run resumed, so the receipt has to say which of the two just happened.
describe('replyReceipt', () => {
  it('confirms a resuming step when a supervisor is live', () => {
    expect(replyReceipt({ answered: true, supervised: true })).toEqual({ text: 'replied — step resuming', tone: 'ok' })
  })

  it('warns that the answer is queued when nothing is running that project', () => {
    const r = replyReceipt({ answered: true, supervised: false })
    expect(r.tone).toBe('warn')
    expect(r.text).toContain('no supervisor')
  })

  it('says so when there was no open question left to answer', () => {
    const r = replyReceipt({ answered: false, supervised: true })
    expect(r.tone).toBe('warn')
    expect(r.text).toContain('no open question')
  })
})

describe('isApprovalGate — which open question earns a one-click approve', () => {
  it('is the grounded plan step, the one question where "approve" means more than its text', () => {
    expect(isApprovalGate(STEP_ID.plan)).toBe(true)
  })

  it('is not any other step, and not a question with no step at all', () => {
    expect(isApprovalGate(STEP_ID.analyze)).toBe(false)
    expect(isApprovalGate('build-the-thing')).toBe(false)
    expect(isApprovalGate(null)).toBe(false)
  })
})

// The word this browser bundle sends and the predicate the kernel process matches on are now one
// export. This test is what would catch it if they were ever split apart again: the UI used to
// declare its own 'approve', so a change to the kernel's literal would have left the button
// clicking into a gate that no longer recognised it.
describe('the approve button sends what the kernel gate accepts', () => {
  it('the canonical word satisfies the kernel predicate, already trimmed and folded', () => {
    expect(isApprovalAnswer(APPROVAL_ANSWER)).toBe(true)
    expect(APPROVAL_ANSWER.trim().toLowerCase()).toBe(APPROVAL_ANSWER)
  })
})
