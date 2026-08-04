import { describe, expect, it } from 'bun:test'
import { completedFraction, isFinished, waveState } from './plan-status'

describe('isFinished — a step says completed where a task says done', () => {
  it('accepts both spellings, because both reach these surfaces', () => {
    expect(isFinished('completed')).toBe(true)
    expect(isFinished('done')).toBe(true)
    expect(isFinished('running')).toBe(false)
  })
})

describe('waveState', () => {
  it('is completed only when every step is', () => {
    expect(waveState(['completed', 'done'])).toBe('completed')
    expect(waveState(['completed', 'running'])).toBe('running')
  })

  /**
   * Order matters here. A wave holding one failure AND one still-running step is RUNNING: the
   * operator can still act on it, and calling it failed would announce it as over.
   */
  it('reports running over failed while anything is still going', () => {
    expect(waveState(['failed', 'running'])).toBe('running')
    expect(waveState(['failed', 'pending'])).toBe('failed')
  })

  it('calls an empty wave pending — "all of nothing" must never read as success', () => {
    expect(waveState([])).toBe('pending')
  })
})

describe('completedFraction', () => {
  it('counts both finished spellings', () => {
    expect(completedFraction(['completed', 'done', 'running', 'pending'])).toBe(0.5)
  })
  it('is zero for an empty plan rather than NaN', () => {
    expect(completedFraction([])).toBe(0)
  })
})
