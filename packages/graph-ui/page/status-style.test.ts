import { describe, expect, it } from 'bun:test'
import { PALETTE } from '@orc/ui-core/palette'
import { colorFor, isActive, planState, TYPE_COLORS } from './status-style'

describe('status-style', () => {
  it('overrides task/step color for live statuses', () => {
    expect(colorFor('step', 'running')).toBe(PALETTE.running)
    expect(colorFor('task', 'running')).toBe(PALETTE.running)
    expect(colorFor('step', 'failed')).toBe(PALETTE.danger)
    expect(colorFor('task', 'blocked')).toBe(PALETTE.danger)
    expect(colorFor('task', 'cancelled')).toBe(PALETTE.cancelled)
  })

  it('keeps type colors for settled statuses and non-lifecycle nodes', () => {
    expect(colorFor('step', 'completed')).toBe(TYPE_COLORS.step)
    expect(colorFor('step', 'pending')).toBe(TYPE_COLORS.step)
    expect(colorFor('task', 'done')).toBe(TYPE_COLORS.task)
    // a note's detail is its KIND, not a status — must never be recolored
    expect(colorFor('note', 'running')).toBe(TYPE_COLORS.note)
    expect(colorFor('artifact', '12B')).toBe(TYPE_COLORS.artifact)
    expect(colorFor('model', 'anthropic')).toBe(TYPE_COLORS.model)
  })

  it('marks only running tasks/steps as active', () => {
    expect(isActive('step', 'running')).toBe(true)
    expect(isActive('task', 'running')).toBe(true)
    expect(isActive('step', 'completed')).toBe(false)
    expect(isActive('task', 'blocked')).toBe(false)
    expect(isActive('note', 'running')).toBe(false)
  })
})

describe('planState — the chat card must show state without opening the request', () => {
  const wave = (...statuses: string[]) => [{ steps: statuses.map(status => ({ status })) }]

  it('is done only when every step completed', () => {
    expect(planState(wave('completed'))).toBe('done')
    expect(planState(wave('completed', 'completed'))).toBe('done')
    expect(planState(wave('completed', 'pending'))).toBe('pending')
  })

  it('surfaces a failure even when the rest of the plan finished', () => {
    expect(planState(wave('completed', 'failed'))).toBe('failed')
    // failure outranks a still-running sibling too — it is the thing the reader must act on
    expect(planState(wave('running', 'failed'))).toBe('failed')
  })

  it('reports running while any step runs', () => {
    expect(planState(wave('completed', 'running'))).toBe('running')
  })

  it('an empty plan is pending, not done', () => {
    expect(planState([])).toBe('pending') // `every` on an empty array would say done
  })

  it('rolls up across waves, not just the first', () => {
    expect(planState([{ steps: [{ status: 'completed' }] }, { steps: [{ status: 'failed' }] }])).toBe('failed')
  })
})
