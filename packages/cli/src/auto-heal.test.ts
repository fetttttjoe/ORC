import { describe, expect, it } from 'bun:test'
import { AutoHealMode, ClaimClass, ClaimState, KnowledgeToolName, STEP_ROLE, STRATEGY, type ClaimDrift } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { AUTO_SWEEP_TITLE, createAutoHeal, SWEEP_LISTED_IDS, sweepPlanDraft, sweepSpec, type AutoHealDeps } from './auto-heal'

// A hand-cranked scheduler: the debounce contract is about WHICH calls collapse, not wall-clock,
// so the tests own the clock the way loop tests own their fake ports.
function fakeScheduler() {
  let pending: (() => void | Promise<void>) | null = null
  let cancels = 0
  return {
    schedule: (fn: () => void | Promise<void>, _ms: number): (() => void) => {
      pending = fn
      return () => { if (pending === fn) pending = null; cancels++ }
    },
    async fire(): Promise<void> {
      const fn = pending
      pending = null
      if (fn) await fn()
    },
    get armed(): boolean { return pending !== null },
    get cancels(): number { return cancels },
  }
}

const drift = (id: string, state: ClaimState): ClaimDrift => ({
  claim: { id, text: 'T.', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts', symbol: null }], tags: [], sources: [], decision: null, location: 'knowledge/src/a.ts.md' },
  state, basis: null, anchors: [],
})

function harness(over: Partial<AutoHealDeps> = {}) {
  const calls: { sweeps: ClaimDrift[][]; warns: string[] } = { sweeps: [], warns: [] }
  const sched = fakeScheduler()
  const deps: AutoHealDeps = {
    mode: AutoHealMode.draft,
    debounceMs: 1000,
    schedule: sched.schedule,
    suspects: async () => [],
    hasOpenSweep: async () => false,
    draftSweep: async s => { calls.sweeps.push(s) },
    warn: m => { calls.warns.push(m) },
    ...over,
  }
  return { reactor: createAutoHeal(deps), calls, sched }
}

describe('createAutoHeal', () => {
  it('a burst of commits collapses to ONE sweep after the quiet window', async () => {
    const { reactor, calls, sched } = harness({ suspects: async () => [drift('aaaaaaaa', ClaimState.suspect)] })
    reactor.onCommitRecorded()
    reactor.onCommitRecorded()
    reactor.onCommitRecorded()
    expect(sched.cancels).toBe(2)
    expect(calls.sweeps).toEqual([])
    await sched.fire()
    expect(calls.sweeps).toHaveLength(1)
  })

  it("mode 'off' arms nothing at all", () => {
    const { reactor, sched } = harness({ mode: AutoHealMode.off })
    reactor.onCommitRecorded()
    expect(sched.armed).toBe(false)
  })

  it('drafts a sweep over exactly the suspect claims, and none when every claim is clean', async () => {
    const mixed = harness({ suspects: async () => [drift('aaaaaaaa', ClaimState.suspect), drift('bbbbbbbb', ClaimState.clean), drift('cccccccc', ClaimState.unknown)] })
    mixed.reactor.onCommitRecorded()
    await mixed.sched.fire()
    expect(mixed.calls.sweeps.map(s => s.map(d => d.claim.id))).toEqual([['aaaaaaaa']])

    const clean = harness({ suspects: async () => [drift('bbbbbbbb', ClaimState.clean)] })
    clean.reactor.onCommitRecorded()
    await clean.sched.fire()
    expect(clean.calls.sweeps).toEqual([])
  })

  it('drafts nothing while a sweep is already open', async () => {
    const busy = harness({ suspects: async () => [drift('aaaaaaaa', ClaimState.suspect)], hasOpenSweep: async () => true })
    busy.reactor.onCommitRecorded()
    await busy.sched.fire()
    expect(busy.calls.sweeps).toEqual([])
  })

  it('a throwing pass is contained as a warning, never an unhandled rejection', async () => {
    const { reactor, calls, sched } = harness({ suspects: async () => { throw new Error('checkout gone') } })
    reactor.onCommitRecorded()
    await sched.fire()
    expect(calls.warns.length).toBe(1)
    expect(calls.warns[0]).toContain('checkout gone')
    expect(calls.sweeps).toEqual([])
  })

  it('close() disarms a pending window', () => {
    const { reactor, sched } = harness()
    reactor.onCommitRecorded()
    expect(sched.armed).toBe(true)
    reactor.close()
    expect(sched.armed).toBe(false)
  })

  it('the sweep title is a stable constant — dedupe keys on it', () => {
    expect(AUTO_SWEEP_TITLE.length).toBeGreaterThan(0)
  })
})

describe('sweepSpec', () => {
  it('lists each suspect id with its location and teaches the knowledge_check protocol', () => {
    const spec = sweepSpec([drift('aaaaaaaa', ClaimState.suspect), drift('bbbbbbbb', ClaimState.suspect)])
    expect(spec).toContain('aaaaaaaa (knowledge/src/a.ts.md)')
    expect(spec).toContain('bbbbbbbb (knowledge/src/a.ts.md)')
    expect(spec).toContain(KnowledgeToolName.check)
    expect(spec).not.toContain(KnowledgeToolName.write)
    expect(spec).toContain('patch')
  })

  it('caps the listed ids and counts the rest', () => {
    const many = Array.from({ length: SWEEP_LISTED_IDS + 7 }, (_, i) => drift(`id${String(i).padStart(6, '0')}`, ClaimState.suspect))
    const spec = sweepSpec(many)
    expect(spec).toContain('id000049')
    expect(spec).not.toContain('id000050')
    expect(spec).toContain('… and 7 more')
  })
})

describe('sweepPlanDraft', () => {
  it('builds the one-click plan: sweep title, the drafted spec verbatim, the lean budget, an auditor step', () => {
    const draft = sweepPlanDraft('check 9 claims', 15)
    expect(draft.steps).toHaveLength(1)
    const s = must(draft.steps[0], 'first step in sweep draft')
    expect(s.title).toBe(AUTO_SWEEP_TITLE)
    expect(s.instructions).toBe('check 9 claims')
    expect(s.maxIterations).toBe(15)
    expect(s.role).toBe(STEP_ROLE.auditor)
    expect(draft.strategyRef).toBe(STRATEGY.sweep)
  })
})
