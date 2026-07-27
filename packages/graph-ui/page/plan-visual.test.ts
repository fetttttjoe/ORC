import { describe, expect, it } from 'bun:test'
import { isSingleStep, planVisualKey } from './plan-visual'
import type { TodoWave } from '@orc/ui-core'

const wave = (n: number, ...statuses: string[]): TodoWave => ({
  wave: n, parallel: statuses.length > 1,
  steps: statuses.map((status, i) => ({ id: `s${n}${i}`, title: `step ${n}${i}`, status })),
})

describe('isSingleStep — the rule both surfaces now share', () => {
  it('is true only for exactly one step in one wave', () => {
    expect(isSingleStep([wave(1, 'completed')])).toBe(true)
    expect(isSingleStep([wave(1, 'completed', 'completed')])).toBe(false)
    expect(isSingleStep([wave(1, 'completed'), wave(2, 'pending')])).toBe(false)
  })
  // This labels the plan; it does NOT gate the diagram — that always renders, on both surfaces.
  it('an empty plan is not a single-step plan', () => {
    expect(isSingleStep([])).toBe(false)
  })
})

describe('planVisualKey — a cached card repaints exactly when the drawing would change', () => {
  it('changes when any step status changes', () => {
    const before = planVisualKey({ version: 1, mermaid: 'x', waves: [wave(1, 'running')] })
    const after = planVisualKey({ version: 1, mermaid: 'x', waves: [wave(1, 'completed')] })
    expect(after).not.toBe(before)
  })

  it('changes when the plan version changes', () => {
    const v1 = planVisualKey({ version: 1, mermaid: 'x', waves: [wave(1, 'pending')] })
    const v2 = planVisualKey({ version: 2, mermaid: 'x', waves: [wave(1, 'pending')] })
    expect(v2).not.toBe(v1)
  })

  it('is stable when nothing that is drawn changed — an approval right after a proposal must not repaint', () => {
    const a = planVisualKey({ version: 1, mermaid: 'x', waves: [wave(1, 'pending')] })
    const b = planVisualKey({ version: 1, mermaid: 'DIFFERENT but derived from the same steps', waves: [wave(1, 'pending')] })
    expect(b).toBe(a)
  })

  it('distinguishes a status change in a later wave', () => {
    const a = planVisualKey({ version: 1, mermaid: 'x', waves: [wave(1, 'completed'), wave(2, 'pending')] })
    const b = planVisualKey({ version: 1, mermaid: 'x', waves: [wave(1, 'completed'), wave(2, 'running')] })
    expect(b).not.toBe(a)
  })
})
