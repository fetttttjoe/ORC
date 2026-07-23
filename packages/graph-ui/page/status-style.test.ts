import { describe, expect, it } from 'bun:test'
import { PALETTE } from '@orc/ui-core/palette'
import { colorFor, isActive, TYPE_COLORS } from './status-style'

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
