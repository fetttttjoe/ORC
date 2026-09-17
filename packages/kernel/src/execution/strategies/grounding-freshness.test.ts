import { describe, expect, it } from 'bun:test'
import { decideGroundingFreshness, type GroundingNoteRef, type GroundingSource } from './grounding-freshness'
import { must } from '@orc/contracts/fixtures'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const OLDER = 'c'.repeat(40)

// A hand-written fake: no git repo, no database, no store. The whole point of the module is that
// the decision is a pure function of three answers, so the fake IS the specification of the seam.
function fakeSource(s: {
  head?: string | null
  notes?: GroundingNoteRef[]
  commits?: (rev: string, paths: string[]) => number | null
}): GroundingSource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    head: async () => { calls.push('head'); return s.head === undefined ? HEAD : s.head },
    notes: async () => { calls.push('notes'); return s.notes ?? [] },
    commitsSince: async (rev, paths) => {
      calls.push(`commitsSince:${rev}:${paths.join(',')}`)
      return s.commits ? s.commits(rev, paths) : 0
    },
  }
}

const note = (over: Partial<GroundingNoteRef> = {}): GroundingNoteRef =>
  ({ id: 'area-kernel', sourceRevision: OLD, paths: ['packages/kernel/src/kernel.ts'], ...over })

describe('decideGroundingFreshness', () => {
  it('is fresh when every note declares paths that have not moved since its sourceRevision', async () => {
    const src = fakeSource({
      notes: [
        note({ id: 'area-kernel', sourceRevision: OLD, paths: ['packages/kernel/src/kernel.ts'] }),
        note({ id: 'area-memory', sourceRevision: OLDER, paths: ['plugins/memory/src/step.ts', 'plugins/memory/src/drift.ts'] }),
      ],
      commits: () => 0,
    })
    const v = await decideGroundingFreshness(src)

    expect(v.fresh).toBe(true)
    expect(v.stale).toEqual([])
    expect(v.current.map(c => c.id)).toEqual(['area-kernel', 'area-memory'])
    // the verdict is self-contained evidence: the sha it compared against travels with it
    expect(v.head).toBe(HEAD)
    expect(v.current.map(c => c.revision)).toEqual([OLD, OLDER])
    for (const c of v.current) expect(c.why.length).toBeGreaterThan(0)
    expect(v.reason).toContain(HEAD)
  })

  it('checks a note whose sourceRevision IS head against the WORKING TREE — an unstaged edit is stale', async () => {
    // The fix: NO rev===head free pass. orc edits source without committing, so a note written at the
    // current HEAD can still be stale against an unstaged edit to its paths — the gate must diff the
    // working tree (commitsSince), never trust "written at HEAD".
    const src = fakeSource({ notes: [note({ sourceRevision: HEAD })], commits: () => 7 })
    const v = await decideGroundingFreshness(src)

    expect(v.fresh).toBe(false)
    expect(src.calls.some(c => c.startsWith('commitsSince'))).toBe(true) // it DID diff the working tree
  })

  it('a note at head whose paths are unchanged in the working tree is current', async () => {
    const src = fakeSource({ notes: [note({ sourceRevision: HEAD })], commits: () => 0 })
    const v = await decideGroundingFreshness(src)
    expect(v.fresh).toBe(true)
  })

  it('is stale when a note\'s declared paths moved since its sourceRevision', async () => {
    const src = fakeSource({
      notes: [
        note({ id: 'quiet', sourceRevision: OLD, paths: ['a.ts'] }),
        note({ id: 'moved', sourceRevision: OLD, paths: ['b.ts'] }),
      ],
      commits: (_rev, paths) => (paths.includes('b.ts') ? 3 : 0),
    })
    const v = await decideGroundingFreshness(src)

    expect(v.fresh).toBe(false)
    expect(v.stale.map(s => s.id)).toEqual(['moved'])
    expect(must(v.stale[0], 'v.stale[0]').why).toContain('3')
    expect(v.current.map(c => c.id)).toEqual(['quiet'])
  })

  it('is not fresh when there are no grounding notes at all, and says so', async () => {
    const v = await decideGroundingFreshness(fakeSource({ notes: [] }))

    expect(v.fresh).toBe(false)
    expect(v.reason).toContain('no grounding notes')
    expect(v.current).toEqual([])
    expect(v.stale).toEqual([])
  })

  // git being unable to answer is never evidence of currency — the gate fails OPEN to analyzing
  it('is not fresh when git cannot resolve HEAD', async () => {
    const v = await decideGroundingFreshness(fakeSource({ head: null, notes: [note()] }))

    expect(v.fresh).toBe(false)
    expect(v.head).toBeNull()
    expect(v.stale.map(s => s.id)).toEqual(['area-kernel'])
    expect(must(v.stale[0], 'v.stale[0]').why.toLowerCase()).toContain('head')
  })

  it('is not fresh when a commitsSince probe cannot answer', async () => {
    const v = await decideGroundingFreshness(fakeSource({ notes: [note()], commits: () => null }))

    expect(v.fresh).toBe(false)
    expect(must(v.stale[0], 'v.stale[0]').why.toLowerCase()).toContain('could not')
  })

  // Path-awareness is the point (plugins/memory/src/step.ts's in-code measurement): a note that
  // declares nothing to compare cannot be scored current by bare HEAD equality alone.
  it('is stale for a note with no sourceRevision, and for one with no declared paths', async () => {
    const v = await decideGroundingFreshness(fakeSource({
      notes: [note({ id: 'unversioned', sourceRevision: null }), note({ id: 'pathless', paths: [] })],
      commits: () => 0,
    }))

    expect(v.fresh).toBe(false)
    expect(v.stale.map(s => s.id).sort()).toEqual(['pathless', 'unversioned'])
    expect(must(v.stale.find(s => s.id === 'unversioned'), 'v.stale.find(s => s.id === \'unversioned\')').revision).toBeNull()
    expect(v.current).toEqual([])
  })

  it('classifies every note into exactly one of current/stale, with a why on each', async () => {
    const v = await decideGroundingFreshness(fakeSource({
      notes: [note({ id: 'a' }), note({ id: 'b', sourceRevision: null }), note({ id: 'c', paths: ['x.ts'] })],
      commits: (_rev, paths) => (paths.includes('x.ts') ? 2 : 0),
    }))

    expect([...v.current, ...v.stale].map(n => n.id).sort()).toEqual(['a', 'b', 'c'])
    for (const n of [...v.current, ...v.stale]) expect(n.why).toBeTruthy()
  })
})
