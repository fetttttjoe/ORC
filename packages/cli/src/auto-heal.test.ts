import { describe, expect, it } from 'bun:test'
import { AutoHealMode, ClaimClass, ClaimState, FS_LIST_TOOL_NAME, KnowledgeToolName, STEP_ROLE, STRATEGY, type ClaimDrift } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { AUTO_SWEEP_TITLE, createAutoHeal, SWEEP_LISTED_IDS, sweepPlanDraft, sweepSpec, type AutoHealDeps } from './auto-heal'

// hand-cranked scheduler: the debounce contract is about which calls collapse, not wall-clock
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

const anchored = (id: string, anchors: ClaimDrift['claim']['anchors']): ClaimDrift => {
  const d = drift(id, ClaimState.suspect)
  return { ...d, claim: { ...d.claim, anchors } }
}

function harness(over: Partial<AutoHealDeps> = {}) {
  const calls: { sweeps: ClaimDrift[][]; warns: string[] } = { sweeps: [], warns: [] }
  const sched = fakeScheduler()
  const deps: AutoHealDeps = {
    mode: AutoHealMode.draft,
    debounceMs: 1000,
    schedule: sched.schedule,
    suspects: async () => [],
    hasOpenSweep: async () => false,
    draftSweep: async (_w, s) => { calls.sweeps.push(s) },
    warn: m => { calls.warns.push(m) },
    ...over,
  }
  return { reactor: createAutoHeal(deps), calls, sched }
}

describe('createAutoHeal', () => {
  it('a burst of commits collapses to ONE sweep after the quiet window', async () => {
    const { reactor, calls, sched } = harness({ suspects: async () => [drift('aaaaaaaa', ClaimState.suspect)] })
    reactor.onCommitRecorded(null)
    reactor.onCommitRecorded(null)
    reactor.onCommitRecorded(null)
    expect(sched.cancels).toBe(2)
    expect(calls.sweeps).toEqual([])
    await sched.fire()
    expect(calls.sweeps).toHaveLength(1)
  })

  it("mode 'off' arms nothing at all", () => {
    const { reactor, sched } = harness({ mode: AutoHealMode.off })
    reactor.onCommitRecorded(null)
    expect(sched.armed).toBe(false)
  })

  it('drafts a sweep over exactly the suspect claims, and none when every claim is clean', async () => {
    const mixed = harness({ suspects: async () => [drift('aaaaaaaa', ClaimState.suspect), drift('bbbbbbbb', ClaimState.clean), drift('cccccccc', ClaimState.unknown)] })
    mixed.reactor.onCommitRecorded(null)
    await mixed.sched.fire()
    expect(mixed.calls.sweeps.map(s => s.map(d => d.claim.id))).toEqual([['aaaaaaaa']])

    const clean = harness({ suspects: async () => [drift('bbbbbbbb', ClaimState.clean)] })
    clean.reactor.onCommitRecorded(null)
    await clean.sched.fire()
    expect(clean.calls.sweeps).toEqual([])
  })

  it('drafts nothing while a sweep is already open', async () => {
    const busy = harness({ suspects: async () => [drift('aaaaaaaa', ClaimState.suspect)], hasOpenSweep: async () => true })
    busy.reactor.onCommitRecorded(null)
    await busy.sched.fire()
    expect(busy.calls.sweeps).toEqual([])
  })

  it('a throwing pass is contained as a warning, never an unhandled rejection', async () => {
    const { reactor, calls, sched } = harness({ suspects: async () => { throw new Error('checkout gone') } })
    reactor.onCommitRecorded(null)
    await sched.fire()
    expect(calls.warns.length).toBe(1)
    expect(calls.warns[0]).toContain('checkout gone')
    expect(calls.sweeps).toEqual([])
  })

  it('commits from two workspaces in one burst draft one sweep each, from that workspace\'s own suspects', async () => {
    const read: (string | null)[] = []
    const drafted: { workspaceId: string | null; ids: string[] }[] = []
    const { reactor, sched } = harness({
      suspects: async w => { read.push(w); return [drift(`claim-${w}`, ClaimState.suspect)] },
      draftSweep: async (workspaceId, s) => { drafted.push({ workspaceId, ids: s.map(d => d.claim.id) }) },
    })
    reactor.onCommitRecorded('ws-a')
    reactor.onCommitRecorded('ws-b')
    reactor.onCommitRecorded('ws-a')
    await sched.fire()
    expect(read).toEqual(['ws-a', 'ws-b'])
    expect(drafted).toEqual([{ workspaceId: 'ws-a', ids: ['claim-ws-a'] }, { workspaceId: 'ws-b', ids: ['claim-ws-b'] }])
  })

  it('a null workspace is read as null, and the burst is cleared after the pass', async () => {
    const read: (string | null)[] = []
    const { reactor, sched } = harness({ suspects: async w => { read.push(w); return [] } })
    reactor.onCommitRecorded(null)
    await sched.fire()
    reactor.onCommitRecorded('ws-a')
    await sched.fire()
    expect(read).toEqual([null, 'ws-a'])
  })

  it('one workspace failing to read warns and still drafts the other', async () => {
    const drafted: (string | null)[] = []
    const { reactor, calls, sched } = harness({
      suspects: async w => { if (w === 'ws-a') throw new Error('workspace ws-a is unknown'); return [drift('bbbbbbbb', ClaimState.suspect)] },
      draftSweep: async w => { drafted.push(w) },
    })
    reactor.onCommitRecorded('ws-a')
    reactor.onCommitRecorded('ws-b')
    await sched.fire()
    expect(drafted).toEqual(['ws-b'])
    expect(calls.warns).toHaveLength(1)
    expect(calls.warns[0]).toContain('ws-a')
  })

  it('a sweep open in one workspace does not block another', async () => {
    const drafted: (string | null)[] = []
    const { reactor, sched } = harness({
      suspects: async () => [drift('aaaaaaaa', ClaimState.suspect)],
      hasOpenSweep: async w => w === 'ws-a',
      draftSweep: async w => { drafted.push(w) },
    })
    reactor.onCommitRecorded('ws-a')
    reactor.onCommitRecorded('ws-b')
    await sched.fire()
    expect(drafted).toEqual(['ws-b'])
  })

  it('close() disarms a pending window', () => {
    const { reactor, sched } = harness()
    reactor.onCommitRecorded(null)
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
    expect(spec).toContain('aaaaaaaa @src/a.ts (knowledge/src/a.ts.md)')
    expect(spec).toContain('bbbbbbbb @src/a.ts (knowledge/src/a.ts.md)')
    expect(spec).toContain(KnowledgeToolName.check)
    expect(spec).not.toContain(KnowledgeToolName.write)
    expect(spec).toContain('patch')
  })

  it('lists each claim\'s anchors, symbol after a hash, and states the folder rule once', () => {
    const spec = sweepSpec([
      anchored('aaaaaaaa', [{ path: 'src/a.ts', symbol: 'run' }, { path: 'src/dir', symbol: null }]),
      anchored('bbbbbbbb', [{ path: 'src/b.ts', symbol: null }]),
    ])
    expect(spec).toContain('aaaaaaaa @src/a.ts#run @src/dir (knowledge/src/a.ts.md)')
    expect(spec).toContain('bbbbbbbb @src/b.ts (knowledge/src/a.ts.md)')
    expect(spec).toContain(`A folder anchor names a directory: list it with ${FS_LIST_TOOL_NAME} and never guess a file in it`)
    expect(spec.split('A folder anchor').length).toBe(2)
  })

  it('tells the auditor to recount a numeric claim before holding it', () => {
    const spec = sweepSpec([drift('aaaaaaaa', ClaimState.suspect)])
    expect(spec).toContain('A claim whose text states a number — a count, a size, a limit — holds only after you recount that exact number in the code; if the number no longer matches, correct the claim, never hold it as-is.')
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
