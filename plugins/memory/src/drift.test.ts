import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { corpusDrift, createDriftProbe, needsReground, noteHasDrifted, CORPUS_DRIFT_ADVISORY, type ChangedSince } from './drift'

const note = (over: Partial<{ sourceRevision: string | null; paths: string[] }> = {}) =>
  ({ sourceRevision: 'abc123', paths: ['packages/kernel/src/kernel.ts'], ...over })

describe('noteHasDrifted', () => {
  it('drifts when a declared file changed', () => {
    expect(noteHasDrifted(note(), new Set(['packages/kernel/src/kernel.ts']))).toBe(true)
  })

  it('does not drift when other files changed', () => {
    expect(noteHasDrifted(note(), new Set(['docs/ARCHITECTURE.md', 'packages/cli/src/main.ts']))).toBe(false)
  })

  it('treats a declared DIRECTORY as drifted when anything under it moves', () => {
    const dir = note({ paths: ['packages/kernel'] })
    expect(noteHasDrifted(dir, new Set(['packages/kernel/src/kernel.ts']))).toBe(true)
    // a sibling that merely shares the prefix is NOT under it
    expect(noteHasDrifted(dir, new Set(['packages/kernel-extra/x.ts']))).toBe(false)
    expect(noteHasDrifted(note({ paths: ['packages/kernel/'] }), new Set(['packages/kernel/src/a.ts']))).toBe(true)
  })

  // every unknown fails toward "not drifted": treating unknown as rot would send every agent back
  // to re-reading the code, which is the cost the graph exists to avoid
  it('is never drifted when the check cannot be made', () => {
    expect(noteHasDrifted(note(), null)).toBe(false)                       // no repo / unreachable rev
    expect(noteHasDrifted(note({ sourceRevision: null }), new Set(['packages/kernel/src/kernel.ts']))).toBe(false)
    expect(noteHasDrifted(note({ paths: [] }), new Set(['anything']))).toBe(false)
    expect(noteHasDrifted(note({ paths: [''] }), new Set(['anything']))).toBe(false)
  })
})

describe('createDriftProbe', () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-drift-'))
    const run = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@t.t')
    run('config', 'user.name', 't')
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1\n')
    run('add', '-A')
    run('commit', '-qm', 'base')
    return dir
  }

  const head = (dir: string) => Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim()

  it('reports a file edited since the revision, including uncommitted work', async () => {
    const dir = repo()
    const rev = head(dir)
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2\n') // never committed
    const changed = await createDriftProbe(dir)(rev)
    expect(changed).not.toBeNull()
    expect([...changed!]).toEqual(['src/a.ts'])
    expect(noteHasDrifted({ sourceRevision: rev, paths: ['src/a.ts'] }, changed)).toBe(true)
    expect(noteHasDrifted({ sourceRevision: rev, paths: ['src/b.ts'] }, changed)).toBe(false)
  })

  it('returns null — never a false positive — for a revision git cannot reach', async () => {
    expect(await createDriftProbe(repo())('0'.repeat(40))).toBeNull()
    expect(await createDriftProbe(mkdtempSync(path.join(tmpdir(), 'orc-norepo-')))('abc123')).toBeNull()
  })
})

describe('corpusDrift — the graph lagging the CODE, not the log', () => {
  const probe = (changed: Record<string, string[] | null>): ChangedSince =>
    async rev => (changed[rev] === null || changed[rev] === undefined ? null : new Set(changed[rev]))

  it('counts only notes that CAN be checked, and reports the share that moved', async () => {
    const d = await corpusDrift([
      { sourceRevision: 'r1', paths: ['a.ts'] },   // changed → drifted
      { sourceRevision: 'r1', paths: ['b.ts'] },   // untouched
      { sourceRevision: null, paths: ['a.ts'] },   // never stamped — uncheckable
      { sourceRevision: 'r1', paths: [] },         // declares nothing — uncheckable
    ], probe({ r1: ['a.ts'] }))
    expect(d).toEqual({ checkable: 2, drifted: 1, total: 4, ratio: 0.5 })
  })

  // The rule the whole module is built on: unknown is never drifted. A revision git cannot reach
  // (rebased away, shallow clone) must not inflate the ratio, or a rebase reads as rot.
  it('drops an unreachable revision from the denominator rather than counting it', async () => {
    const d = await corpusDrift([
      { sourceRevision: 'gone', paths: ['a.ts'] },
      { sourceRevision: 'r1', paths: ['a.ts'] },
    ], probe({ gone: null, r1: ['a.ts'] }))
    expect(d.checkable).toBe(1)
    expect(d.ratio).toBe(1)
  })

  it('reports null rather than 0 when nothing is checkable — 0 would read as healthy', async () => {
    const d = await corpusDrift([{ sourceRevision: null, paths: [] }], probe({}))
    expect(d.ratio).toBeNull()
    expect(needsReground(d)).toBe(false) // unknown is never a reason to rebuild
  })

  it('calls for a re-ground only past the threshold', () => {
    expect(needsReground({ ratio: CORPUS_DRIFT_ADVISORY - 0.01 })).toBe(false)
    expect(needsReground({ ratio: CORPUS_DRIFT_ADVISORY })).toBe(true)
    expect(needsReground({ ratio: 1 })).toBe(true)
  })
})
