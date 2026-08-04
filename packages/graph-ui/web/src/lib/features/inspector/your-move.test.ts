import { describe, expect, it } from 'bun:test'
import { yourMove, type MoveInput } from './your-move'

const base: MoveInput = { taskId: 't1', status: 'running', failedStepId: null, openQuestion: null, artifactCount: 0 }

describe('yourMove (the single next human action)', () => {
  it('a failed step outranks everything — including an open question', () => {
    const m = yourMove({ ...base, status: 'blocked', failedStepId: 'verify', openQuestion: 'which model?' })
    expect(m.kind).toBe('retry')
    expect(m.text).toContain('verify')
    expect(m.cmd).toBe('orc retry t1')
  })

  it('an open question outranks the lifecycle status', () => {
    const m = yourMove({ ...base, status: 'awaiting_approval', openQuestion: 'may I analyze?' })
    expect(m.kind).toBe('answer')
    expect(m.text).toContain('may I analyze?')
  })

  it('walks the lifecycle when nothing is waiting', () => {
    expect(yourMove({ ...base, status: 'draft' }).kind).toBe('propose')
    expect(yourMove({ ...base, status: 'awaiting_approval' }).kind).toBe('approve')
    expect(yourMove({ ...base, status: 'approved' }).kind).toBe('run')
    expect(yourMove({ ...base, status: 'running' }).kind).toBe('watch')
    expect(yourMove({ ...base, status: 'done', artifactCount: 3 }).text).toContain('3 verified')
  })

  it('every actionable move carries its CLI equivalent; watching carries none', () => {
    for (const status of ['draft', 'awaiting_approval', 'approved']) expect(yourMove({ ...base, status }).cmd).toBeTruthy()
    expect(yourMove({ ...base, status: 'running' }).cmd).toBeNull()
  })
})

describe('yourMove — a verdict is answered by replanning, never by repeating', () => {
  const base = { taskId: 't1', status: 'blocked', openQuestion: null, artifactCount: 0 }

  it('offers retry when a step BROKE', () => {
    const m = yourMove({ ...base, failedStepId: 'verify' })
    expect(m.kind).toBe('retry')
  })

  /**
   * The loop this exists to end: retry re-runs only what did not complete, so a rejecting step
   * meets the same completed siblings and reaches the same verdict — three identical audit passes
   * were observed before this distinction existed.
   */
  it('offers REPLAN when the step rejected the work, and never retry', () => {
    const m = yourMove({ ...base, failedStepId: 'verify', rejected: true })
    expect(m.kind).toBe('replan')
    expect(m.kind).not.toBe('retry')
    expect(m.text).toContain('rejected')
  })

  it('still lets an open question outrank neither — a failure is dealt with first', () => {
    expect(yourMove({ ...base, failedStepId: 'verify', rejected: true, openQuestion: 'which one?' }).kind).toBe('replan')
  })
})
