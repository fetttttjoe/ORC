import { describe, expect, it } from 'bun:test'
import { AUTO_HEAL_MODE, STRATEGY } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { AUTO_SWEEP_TITLE, createAutoHeal, sweepPlanDraft, type AutoHealDeps } from './auto-heal'

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

function harness(over: Partial<AutoHealDeps> = {}) {
  const calls: { restamp: number; drifted: number; sweeps: number[]; warns: string[] } = { restamp: 0, drifted: 0, sweeps: [], warns: [] }
  const sched = fakeScheduler()
  const deps: AutoHealDeps = {
    mode: AUTO_HEAL_MODE.draftSweep,
    debounceMs: 1000,
    schedule: sched.schedule,
    restamp: async () => { calls.restamp++; return 2 },
    drifted: async () => { calls.drifted++; return 0 },
    hasOpenSweep: async () => false,
    draftSweep: async n => { calls.sweeps.push(n) },
    warn: m => { calls.warns.push(m) },
    ...over,
  }
  return { reactor: createAutoHeal(deps), calls, sched }
}

describe('createAutoHeal', () => {
  it('a burst of commits collapses to ONE restamp after the quiet window', async () => {
    const { reactor, calls, sched } = harness()
    reactor.onCommitRecorded()
    reactor.onCommitRecorded()
    reactor.onCommitRecorded()
    expect(sched.cancels).toBe(2) // each commit reset the window
    expect(calls.restamp).toBe(0) // nothing runs until the window closes
    await sched.fire()
    expect(calls.restamp).toBe(1)
  })

  it("mode 'off' arms nothing at all", () => {
    const { reactor, sched } = harness({ mode: AUTO_HEAL_MODE.off })
    reactor.onCommitRecorded()
    expect(sched.armed).toBe(false)
  })

  it("mode 'restamp' never consults drift and never drafts", async () => {
    const { reactor, calls, sched } = harness({ mode: AUTO_HEAL_MODE.restamp, drifted: async () => 9 })
    reactor.onCommitRecorded()
    await sched.fire()
    expect(calls.restamp).toBe(1)
    expect(calls.drifted).toBe(0)
    expect(calls.sweeps).toEqual([])
  })

  it('draft-sweep drafts exactly when drift survives the restamp and no sweep is already open', async () => {
    const { reactor, calls, sched } = harness({ drifted: async () => 5 })
    reactor.onCommitRecorded()
    await sched.fire()
    expect(calls.sweeps).toEqual([5]) // drifted > 0, no open sweep → drafted, carrying the count

    const clean = harness({ drifted: async () => 0 })
    clean.reactor.onCommitRecorded()
    await clean.sched.fire()
    expect(clean.calls.sweeps).toEqual([]) // the restamp settled everything — nothing to draft

    const busy = harness({ drifted: async () => 5, hasOpenSweep: async () => true })
    busy.reactor.onCommitRecorded()
    await busy.sched.fire()
    expect(busy.calls.sweeps).toEqual([]) // one open sweep is the cap — never a queue of them
  })

  it('a throwing pass is contained as a warning, never an unhandled rejection', async () => {
    const { reactor, calls, sched } = harness({ restamp: async () => { throw new Error('surreal down') } })
    reactor.onCommitRecorded()
    await sched.fire()
    expect(calls.warns.length).toBe(1)
    expect(calls.warns[0]).toContain('surreal down')
    expect(calls.sweeps).toEqual([]) // a failed restamp must not still spend on a sweep draft
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

describe('sweepPlanDraft', () => {
  it('builds the one-click plan: sweep title, the drafted spec verbatim, and the LEAN budget', () => {
    const draft = sweepPlanDraft('heal 9 notes: recheck first', 15)
    expect(draft.steps).toHaveLength(1)
    const s = must(draft.steps[0], 'first step in sweep draft')
    expect(s.title).toBe(AUTO_SWEEP_TITLE) // the dedupe key hasOpenSweep matches on
    expect(s.instructions).toBe('heal 9 notes: recheck first')
    // the knob is the whole point: the general default (60) over-provisioned every sweep, and a
    // sweep that genuinely needs more signals 'partial' and continues under runtime grants
    expect(s.maxIterations).toBe(15)
    // EXEMPT from the kernel's finish step: the sweep is machine-drafted maintenance, not a
    // request, and a finish step would park it on a human who never asked for it. The strategyRef
    // is how the kernel knows (FINISH_EXEMPT_STRATEGIES) — nothing else distinguishes this draft
    // from an operator's quick task.
    expect(draft.strategyRef).toBe(STRATEGY.sweep)
  })
})
