import { describe, expect, it } from 'bun:test'
import { renderPlanHuman } from './plan-render'
import { singleStepDraft } from './actions'

const plan = { version: 2, ...singleStepDraft({ title: 'summarize notes', spec: 'read notes.txt, write summary.md' }, 'anthropic/claude-haiku-4-5') }

describe('renderPlanHuman', () => {
  it('renders steps with model, rate, budget, and honest missing-estimate line', () => {
    const out = renderPlanHuman(plan, ref => (ref === 'anthropic/claude-haiku-4-5' ? '$1/M in · $5/M out' : null))
    expect(out).toContain('plan v2 · 1 step(s)')
    expect(out).toContain('cost estimate: none provided')
    expect(out).toContain('s1  [worker] summarize notes')
    expect(out).toContain('anthropic/claude-haiku-4-5 ($1/M in · $5/M out) · ≤30 iterations')
    expect(out).toContain('read notes.txt, write summary.md')
  })
  it('shows a provided estimate and survives a missing rate', () => {
    const out = renderPlanHuman({ ...plan, costEstimateUSD: 0.5 })
    expect(out).toContain('cost estimate: $0.50')
    expect(out).not.toContain('(null)')
  })
})
