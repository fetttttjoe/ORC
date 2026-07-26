import { describe, expect, it } from 'bun:test'
import { renderDerivedPlan, renderPlanHuman } from './plan-render'
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

// Reproduced live 2026-07-26: the plan agent's prose said "verify depends on draft"; the verify
// plan-note had links: []. finalize_plan froze dependsOn: [] and the two raced. The plan hash binds
// the human's approval to the note graph — which they were never shown.
describe('renderDerivedPlan', () => {
  const step = (id: string, dependsOn: string[] = [], zone: string[] = []) =>
    ({ id, role: 'implementer', title: id, instructions: 'x', dependsOn, skillRefs: [], toolRefs: [], zone })

  it('states each step’s real ordering, so prose claiming a sequence can be checked', () => {
    const out = renderDerivedPlan({ steps: [step('draft'), step('verify', ['draft'])] })
    expect(out).toContain('after draft')
    expect(out).not.toMatch(/unordered/)
  })

  it('calls out an all-unordered plan — the exact shape that raced', () => {
    const out = renderDerivedPlan({ steps: [step('draft'), step('verify')] })
    expect(out).toContain('no dependencies')
    expect(out).toMatch(/unordered/)
  })

  it('shows the write fence, so two steps aimed at one file are visible', () => {
    expect(renderDerivedPlan({ steps: [step('draft', [], ['docs/page.md'])] })).toContain('docs/page.md')
  })
})
