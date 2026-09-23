import { describe, expect, it } from 'bun:test'
import { symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaimClass, DRIFT_STATE, type ClaimInput } from '@orc/contracts'
import { sh } from '@orc/kernel/test-helpers'
import { createBlobProbe, readCorpusDrift, readNoteDrift, type BlobsAt, type DriftSources } from './claim-drift-read'
import { tmpSourceRepo } from './test-helpers'

const A = 'src/a.ts'
const B = 'src/b.ts'

const claim = (id: string, anchors: { path: string; blob: string | null }[]): ClaimInput => ({
  id, text: `statement ${id}`, class: ClaimClass.fact, sourceRevision: 'r1',
  anchors: anchors.map(a => ({ ...a, symbol: null })),
})

/** a path this checkout says nothing about is ABSENT — the reader must not read that as a deletion */
const blobsOf = (blobs: Record<string, string | null>): BlobsAt => async paths => {
  const out = new Map<string, string | null>()
  for (const p of paths) {
    const seen = blobs[p]
    if (seen !== undefined) out.set(p, seen)
  }
  return out
}

const sources = (changed: Record<string, string[] | null>, blobs: Record<string, string | null> = {}): DriftSources => ({
  changedSince: async rev => (changed[rev] === null || changed[rev] === undefined ? null : new Set(changed[rev])),
  blobsAt: blobsOf(blobs),
})

describe('createBlobProbe', () => {
  it('hashes a file of the checkout, and caches one observation per path', async () => {
    const { dir } = tmpSourceRepo('orc-blob-')
    const probe = createBlobProbe(dir)
    const first = await probe([A])
    expect(first.get(A)).toBe(sh(dir, 'hash-object', '--', A))
    writeFileSync(path.join(dir, A), 'export const a = 2\n')
    expect((await probe([A])).get(A)).toBe(first.get(A))
    expect((await createBlobProbe(dir)([A])).get(A)).not.toBe(first.get(A))
  })

  it('reports a missing file as GONE and a path it cannot hash as cannot-tell', async () => {
    const { dir } = tmpSourceRepo('orc-blob-')
    const outside = path.join(tmpdir(), `orc-outside-${Date.now()}.ts`)
    writeFileSync(outside, 'export const out = 1\n')
    symlinkSync(outside, path.join(dir, 'src', 'link.ts'))
    const seen = await createBlobProbe(dir)(['src/gone.ts', '../outside.ts', 'src/link.ts'])
    expect(seen.get('src/gone.ts')).toBeNull()
    expect(seen.has('../outside.ts')).toBe(false)
    expect(seen.has('src/link.ts')).toBe(false) // it is there, it just cannot be hashed as ours
  })
})

describe('readNoteDrift', () => {
  it('judges a note that carries claims per claim, never by its declared paths', async () => {
    const note = { sourceRevision: 'r1', paths: [A], claims: [claim('a'.repeat(12), [{ path: A, blob: 'blob-a' }]), claim('b'.repeat(12), [{ path: B, blob: 'blob-b' }])] }
    const d = await readNoteDrift(note, sources({ r1: [A, B] }, { [A]: 'blob-a', [B]: 'blob-moved' }))
    expect(d).toEqual({ state: DRIFT_STATE.drifted, suspectClaims: ['b'.repeat(12)], unknownClaims: [], checkable: true })
  })

  it('is UNKNOWN, and not checkable, when no claim could be compared at all', async () => {
    const note = { sourceRevision: 'r1', paths: [A], claims: [claim('a'.repeat(12), [{ path: A, blob: 'blob-a' }])] }
    const d = await readNoteDrift(note, sources({ r1: [] }, {}))
    expect(d.state).toBe(DRIFT_STATE.unknown)
    expect(d).toMatchObject({ unknownClaims: ['a'.repeat(12)], checkable: false })
  })

  it('keeps the note-path rule for a note that carries no claims', async () => {
    const drifted = await readNoteDrift({ sourceRevision: 'r1', paths: [A] }, sources({ r1: [A] }))
    expect(drifted).toEqual({ state: DRIFT_STATE.drifted, suspectClaims: [], unknownClaims: [], checkable: true })
    const clean = await readNoteDrift({ sourceRevision: 'r1', paths: [B] }, sources({ r1: [A] }))
    expect(clean.state).toBe(DRIFT_STATE.clean)
  })

  it('compares against the verification snapshot when one matches the claim', async () => {
    const id = 'a'.repeat(12)
    const note = {
      sourceRevision: 'r1', paths: [],
      claims: [claim(id, [{ path: A, blob: 'blob-written' }])],
      verified: { revision: 'r2', at: '2026-09-01T00:00:00.000Z', by: 'auditor', claims: [{ claimId: id, anchors: [{ path: A, symbol: null, blob: 'blob-checked' }] }] },
    }
    expect((await readNoteDrift(note, sources({}, { [A]: 'blob-checked' }))).state).toBe(DRIFT_STATE.clean)
    expect((await readNoteDrift(note, sources({}, { [A]: 'blob-written' }))).state).toBe(DRIFT_STATE.drifted)
  })
})

describe('readCorpusDrift', () => {
  it('counts only what CAN be checked, and reports the share that moved', async () => {
    const d = await readCorpusDrift([
      { sourceRevision: 'r1', paths: [A] },
      { sourceRevision: 'r1', paths: [B] },
      { sourceRevision: null, paths: [A] },
      { sourceRevision: 'r1', paths: [] },
    ], sources({ r1: [A] }))
    expect(d).toEqual({ checkable: 2, drifted: 1, unknown: 0, total: 4, ratio: 0.5 })
  })

  it('counts an unreachable revision as unknown rather than inflating the ratio', async () => {
    const d = await readCorpusDrift([
      { sourceRevision: 'gone', paths: [A] },
      { sourceRevision: 'r1', paths: [A] },
    ], sources({ gone: null, r1: [A] }))
    expect(d).toMatchObject({ checkable: 1, drifted: 1, unknown: 1, ratio: 1 })
  })

  it('reports null rather than 0 when nothing is checkable — 0 would read as healthy', async () => {
    const d = await readCorpusDrift([{ sourceRevision: null, paths: [] }], sources({}))
    expect(d.ratio).toBeNull()
  })

  it('a claim-bearing note is counted by its claims, so a moved declared path alone is not drift', async () => {
    const d = await readCorpusDrift(
      [{ sourceRevision: 'r1', paths: [A], claims: [claim('a'.repeat(12), [{ path: A, blob: 'blob-a' }])] }],
      sources({ r1: [A] }, { [A]: 'blob-a' }),
    )
    expect(d).toEqual({ checkable: 1, drifted: 0, unknown: 0, total: 1, ratio: 0 })
  })
})
