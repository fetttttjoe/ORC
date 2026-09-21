import { describe, expect, it } from 'bun:test'
import { Confidence, EVENT_KIND, PAYLOAD_SCHEMAS } from '@orc/contracts'
import type { GroundingVerdict } from './grounding-freshness'
import { groundingDirective, isMixed, mixedGroundingDraft, reusedCitation, scanScope } from './grounding-scope'

const HEAD = 'f'.repeat(40)
const OLD = '1'.repeat(40)

// A realistic mixed verdict: one note current BECAUSE it was written at HEAD (so its `why` names no
// paths — the reused half must never leak a path into the scan scope), two notes stale.
const mixed = (): GroundingVerdict => ({
  fresh: false,
  reason: `2 of 3 grounding note(s) are not provably current at HEAD ${HEAD}: area-execution, area-cli`,
  head: HEAD,
  current: [{ id: 'arch-overview', revision: HEAD, why: `written at HEAD ${HEAD} — nothing has been committed since` }],
  stale: [
    { id: 'area-execution', revision: OLD, why: '3 commit(s) touched its declared path(s) (packages/kernel/src/execution/dbos-port.ts)' },
    { id: 'area-cli', revision: null, why: 'records no sourceRevision — it was never grounded against a commit' },
  ],
})

const answers = () => ({
  'area-execution': { declared: ['packages/kernel/src/execution/dbos-port.ts', 'packages/kernel/src/execution/interpreter.ts'], changed: ['packages/kernel/src/execution/dbos-port.ts'] },
  'area-cli': { declared: ['packages/cli/src'], changed: null },
})

describe('isMixed', () => {
  it('is true only when the verdict is not fresh AND something is still reusable', () => {
    expect(isMixed(mixed())).toBe(true)
    expect(isMixed({ ...mixed(), fresh: true })).toBe(false)
    expect(isMixed({ ...mixed(), current: [] })).toBe(false) // all-stale = today's full scan
  })
})

describe('scanScope', () => {
  it('prefers the probe answer per stale note and falls back to declared paths when it is null', () => {
    const scope = scanScope(mixed(), answers())
    expect(scope.reused).toEqual(['arch-overview'])
    expect(scope.rescan).toEqual(['area-execution', 'area-cli'])
    expect(scope.paths).toEqual(['packages/kernel/src/execution/dbos-port.ts', 'packages/cli/src'])
    expect(scope.probed).toBe(true)
    expect(scope.perNote).toEqual([
      { id: 'area-execution', paths: ['packages/kernel/src/execution/dbos-port.ts'] },
      { id: 'area-cli', paths: ['packages/cli/src'] },
    ])
  })

  it('treats an EMPTY probe answer as no answer — the wider declared list wins over scoping to nothing', () => {
    const scope = scanScope(mixed(), { ...answers(), 'area-execution': { declared: ['a.ts', 'b.ts'], changed: [] } })
    expect(scope.perNote[0]).toEqual({ id: 'area-execution', paths: ['a.ts', 'b.ts'] })
    expect(scope.probed).toBe(false) // nothing was actually narrowed
  })

  it('falls back to declared paths when the probe is absent entirely', () => {
    const scope = scanScope(mixed(), {
      'area-execution': { declared: ['packages/kernel/src/execution/dbos-port.ts'] },
      'area-cli': { declared: ['packages/cli/src'] },
    })
    expect(scope.paths).toEqual(['packages/kernel/src/execution/dbos-port.ts', 'packages/cli/src'])
    expect(scope.probed).toBe(false)
  })

  it('dedupes while keeping stable order and never scopes a REUSED note`s paths', () => {
    const scope = scanScope(mixed(), {
      'area-execution': { declared: [], changed: ['x.ts', 'y.ts', 'x.ts'] },
      'area-cli': { declared: [], changed: ['y.ts', 'z.ts'] },
    })
    expect(scope.paths).toEqual(['x.ts', 'y.ts', 'z.ts'])
    // the current note's own declared path is offered and must still be ignored
    const withCurrentPath = scanScope(mixed(), {
      'area-execution': { declared: ['packages/kernel/src/kernel.ts'], changed: null },
      'area-cli': { declared: [], changed: null },
    })
    expect(withCurrentPath.reused).toEqual(['arch-overview'])
  })
})

describe('groundingDirective', () => {
  const text = () => groundingDirective(mixed(), scanScope(mixed(), answers()))

  it('names the reused notes with revision and instructs refine-by-id, not re-derivation', () => {
    expect(text()).toContain(`arch-overview@${HEAD}`)
    expect(text()).toContain('memory_read')
    expect(text()).toContain('SAME ID')
  })

  it('names each stale note with its reason and exactly the paths scoped for it', () => {
    expect(text()).toContain('area-execution')
    expect(text()).toContain('3 commit(s) touched')
    expect(text()).toContain('packages/kernel/src/execution/dbos-port.ts')
    // the probe narrowed area-execution to one file — the other declared file is NOT in scope
    expect(text()).not.toContain('interpreter.ts')
    expect(text()).toContain('packages/cli/src')
  })

  it('says the rest of the tree is out of scope and states the compared HEAD', () => {
    expect(text()).toContain('OUT OF SCOPE')
    expect(text()).toContain(HEAD)
  })
})

describe('mixedGroundingDraft', () => {
  it('is a valid analysis_completed built purely from the verdict + scope', () => {
    const v = mixed()
    const draft = mixedGroundingDraft(v, scanScope(v, answers()), 'step:t1:analyze:a1')
    expect(draft.kind).toBe(EVENT_KIND.analysis_completed)
    expect(draft.idempotencyKey).toBe('step:t1:analyze:a1:grounding:mixed:analysis_completed')
    const payload = PAYLOAD_SCHEMAS.analysis_completed.parse(draft.payload)
    expect(payload.analyzed).toBe(true)
    expect(payload.notesWritten).toBe(0)
    expect(payload.confidence).toBe(Confidence.medium)
    expect(payload.scope.join(' | ')).toContain(`arch-overview@${HEAD} current at HEAD ${HEAD}`)
    expect(payload.gaps[0]).toContain('incremental re-scan: only 2 path(s) in scope')
    const gaps = payload.gaps.join(' | ')
    expect(gaps).toContain(`area-execution@${OLD}`)
    expect(gaps).toContain('area-cli@no-revision')
    expect(gaps).toContain('packages/kernel/src/execution/dbos-port.ts')
    expect(gaps).toContain('records no sourceRevision')
  })
})

describe('reusedCitation', () => {
  it('cites every reused note with its revision and the compared HEAD, plus the scanned paths', () => {
    const v = mixed()
    const sentence = reusedCitation(v, scanScope(v, answers()))
    expect(sentence).toContain(`arch-overview@${HEAD}`)
    expect(sentence).toContain(HEAD)
    expect(sentence).toContain('memory_read')
    expect(sentence).toContain('packages/kernel/src/execution/dbos-port.ts')
    expect(sentence).toContain('area-cli')
  })
})
