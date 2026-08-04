// Ports the status-precedence semantics of the retired page/status-style onto the app palette:
// status override precedence failed > blocked > running > type default, and note/artifact/model
// are NEVER recolored by a coincidental detail string.
import { describe, expect, it } from 'bun:test'
import { colorFor, EDGE_COLOR, edgeColorFor, isActive, STATUS_COLORS, TYPE_COLORS } from './colors'

describe('status override precedence', () => {
  it('overrides task/step color for live statuses', () => {
    expect(colorFor('step', 'running')).toBe(STATUS_COLORS.running)
    expect(colorFor('task', 'running')).toBe(STATUS_COLORS.running)
    expect(colorFor('step', 'failed')).toBe(STATUS_COLORS.failed)
    expect(colorFor('task', 'failed')).toBe(STATUS_COLORS.failed)
    expect(colorFor('task', 'blocked')).toBe(STATUS_COLORS.blocked)
    expect(colorFor('step', 'blocked')).toBe(STATUS_COLORS.blocked)
    expect(colorFor('task', 'cancelled')).toBe(STATUS_COLORS.cancelled)
  })

  it('failed and blocked outrank running — a dead node must never read as live steel', () => {
    expect(colorFor('task', 'failed')).not.toBe(colorFor('task', 'running'))
    expect(colorFor('task', 'blocked')).not.toBe(colorFor('task', 'running'))
    // blocked shares failed's temperature (rust), exactly as StatusPill maps them
    expect(colorFor('task', 'blocked')).toBe(colorFor('task', 'failed'))
  })

  it('running outranks the type default — the override must be VISIBLE on rest-state steel', () => {
    expect(colorFor('task', 'running')).not.toBe(TYPE_COLORS.task)
    expect(colorFor('step', 'running')).not.toBe(TYPE_COLORS.step)
  })

  it('keeps type colors for settled statuses', () => {
    expect(colorFor('step', 'completed')).toBe(TYPE_COLORS.step)
    expect(colorFor('step', 'pending')).toBe(TYPE_COLORS.step)
    expect(colorFor('task', 'done')).toBe(TYPE_COLORS.task)
  })

  it('never overrides note/artifact/model — their detail is not a lifecycle', () => {
    // a note's detail is its KIND, an artifact's its SIZE — must never be recolored
    expect(colorFor('note', 'running')).toBe(TYPE_COLORS.note)
    expect(colorFor('note', 'failed')).toBe(TYPE_COLORS.note)
    expect(colorFor('artifact', '12B')).toBe(TYPE_COLORS.artifact)
    expect(colorFor('artifact', 'blocked')).toBe(TYPE_COLORS.artifact)
    expect(colorFor('model', 'anthropic')).toBe(TYPE_COLORS.model)
    expect(colorFor('model', 'running')).toBe(TYPE_COLORS.model)
  })
})

describe('isActive — drives the running size bump', () => {
  it('marks only running tasks/steps as active', () => {
    expect(isActive('step', 'running')).toBe(true)
    expect(isActive('task', 'running')).toBe(true)
    expect(isActive('step', 'completed')).toBe(false)
    expect(isActive('task', 'blocked')).toBe(false)
    expect(isActive('note', 'running')).toBe(false)
  })
})

describe('edgeColorFor — heat lerps the rule chrome toward paper', () => {
  it('renders EDGE_COLOR at heat 0 and paper at heat 1', () => {
    // #2e3742 (--color-rule) and #e6e1d6 (--color-paper) as rgb triplets
    expect(edgeColorFor(0)).toBe('rgb(46, 55, 66)')
    expect(EDGE_COLOR).toBe('#2e3742') // the triplet above IS the hex — same canvas color
    expect(edgeColorFor(1)).toBe('rgb(230, 225, 214)')
  })

  it('clamps out-of-range heat instead of extrapolating', () => {
    expect(edgeColorFor(-1)).toBe(edgeColorFor(0))
    expect(edgeColorFor(2)).toBe(edgeColorFor(1))
  })
})
