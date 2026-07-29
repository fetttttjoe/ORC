import { describe, expect, it } from 'bun:test'
import { LINK_KIND, STEP_RUN_STATUS } from '@orc/contracts'
import { decompositionMermaid, planMermaid, todoWaves } from './diagram'

// diamond: a → (b ∥ c) → d
const diamond = [
  { id: 'a', title: 'start', dependsOn: [] },
  { id: 'b', title: 'left', dependsOn: ['a'] },
  { id: 'c', title: 'right', dependsOn: ['a'] },
  { id: 'd', title: 'join', dependsOn: ['b', 'c'] },
]

describe('todoWaves', () => {
  it('layers a diamond into 3 waves with the middle parallel', () => {
    const states = new Map([['a', { status: 'completed' }], ['b', { status: 'running' }]])
    const waves = todoWaves(diamond, states)
    expect(waves.map(w => w.steps.map(s => s.id))).toEqual([['a'], ['b', 'c'], ['d']])
    expect(waves.map(w => w.parallel)).toEqual([false, true, false])
    expect(waves[0]!.steps[0]!.status).toBe('completed')
    expect(waves[1]!.steps[1]!.status).toBe('pending')
  })
  it('stops layering on a cycle instead of looping', () => {
    expect(todoWaves([{ id: 'x', title: 'x', dependsOn: ['y'] }, { id: 'y', title: 'y', dependsOn: ['x'] }])).toEqual([])
  })
})

describe('mermaid generators', () => {
  it('planMermaid escapes hostile titles and classes statuses', () => {
    const text = planMermaid(
      [{ id: 's1', title: 'evil" ]\nx --> pwn', dependsOn: [] }],
      new Map([['s1', { status: 'completed' }]]),
    )
    expect(text).toContain('graph TD')
    expect(text).toContain(":::done")
    expect(text).not.toContain('"\n') // the newline+quote breakout is neutralized
    expect(text).toContain("evil' ] x --> pwn") // escaped, single statement
  })
  it('decompositionMermaid draws decomposes_into solid and depends_on dashed, skipping dangling targets', () => {
    const text = decompositionMermaid([
      { id: 'root', title: 'root', links: [{ id: 'child', kind: 'decomposes_into' }, { id: 'ghost', kind: 'decomposes_into' }] },
      { id: 'child', title: 'child', links: [{ id: 'root', kind: 'depends_on' }] },
    ])
    expect(text).toContain('root --> child')
    // 'child depends_on root' means root runs FIRST, so the arrow points root -> child — the same
    // direction planMermaid uses. Drawn the other way, mermaid lays the plan out inside out.
    expect(text).toContain('root -.-> child')
    expect(text).not.toContain('child -.-> root')
    expect(text).not.toContain('ghost')
  })

  // the subplan-note id IS the child step id (instantiateFrozenPlan), so a decomposition colours
  // from execution rather than sitting pinned at pending
  it('decompositionMermaid colours each subplan from the child step that carries its id', () => {
    const notes = [
      { id: 'root', title: 'root', links: [{ id: 'a', kind: LINK_KIND.decomposes_into }, { id: 'b', kind: LINK_KIND.decomposes_into }] },
      { id: 'a', title: 'a', links: [] },
      { id: 'b', title: 'b', links: [] },
    ]
    const text = decompositionMermaid(notes, new Map([
      ['a', { status: STEP_RUN_STATUS.completed }], ['b', { status: STEP_RUN_STATUS.running }],
    ]))
    expect(text).toContain('a["a"]:::done')
    expect(text).toContain('b["b"]:::running')
    expect(text).toContain('root["root"]:::pending') // no step of its own — pending is accurate
    // no states at all (proposal not yet split) is the old behaviour, unchanged
    expect(decompositionMermaid(notes)).toContain('a["a"]:::pending')
  })

  // Between a subplan's approval and its first step starting there is no run status yet, so the
  // ONLY signal is the approved bit the fold carries — it must render as its own armed state, not
  // pending (indistinguishable from an unapproved proposal).
  it('decompositionMermaid classes an approved-but-not-yet-running subplan as armed', () => {
    const notes = [
      { id: 'root', title: 'root', links: [{ id: 'a', kind: LINK_KIND.decomposes_into }] },
      { id: 'a', title: 'a', links: [] },
    ]
    const text = decompositionMermaid(notes, new Map([['a', { approved: true }]]))
    expect(text).toContain('a["a"]:::armed')
    expect(text).not.toContain('a["a"]:::pending')
    expect(text).not.toContain('a["a"]:::done')
    expect(text).not.toContain('a["a"]:::running')
    expect(text).not.toContain('a["a"]:::failed')
    // the armed classDef is present in the theme so the class resolves
    expect(text).toContain('classDef armed')
  })

  // planMermaid shares the SAME statusClass/THEME path, so the fix is one mechanism: an approved
  // step with no run yet arms there too.
  it('planMermaid classes an approved-but-not-yet-running step as armed (shared mechanism)', () => {
    const text = planMermaid(
      [{ id: 's1', title: 'step one', dependsOn: [] }],
      new Map([['s1', { approved: true }]]),
    )
    expect(text).toContain('s1["step one"]:::armed')
    expect(text).not.toContain('s1["step one"]:::pending')
    expect(text).toContain('classDef armed')
  })

  // a real run status still wins over the armed bit, and an entry that is neither approved nor a
  // recognized status still falls through to pending.
  it('running/done win over the armed bit; an unrecognized entry stays pending', () => {
    const running = planMermaid(
      [{ id: 's1', title: 'x', dependsOn: [] }],
      new Map([['s1', { status: STEP_RUN_STATUS.running, approved: true }]]),
    )
    expect(running).toContain('s1["x"]:::running')
    const stray = planMermaid(
      [{ id: 's1', title: 'x', dependsOn: [] }],
      new Map([['s1', { status: 'bogus' }]]),
    )
    expect(stray).toContain('s1["x"]:::pending')
  })
})
