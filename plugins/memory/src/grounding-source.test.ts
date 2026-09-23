import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NOTE_TIER, type MemoryFilter, type MemoryStore, type NoteSummary } from '@orc/contracts'
import { createGroundingSource } from './grounding-source'
import { summaryFixture, tmpSourceRepo } from './test-helpers'

// Only list() is exercised; every other MemoryStore method throws so a test can never depend on one.
function fakeStore(rows: NoteSummary[]): Pick<MemoryStore, 'list'> & { lastFilter?: MemoryFilter } {
  const store: Pick<MemoryStore, 'list'> & { lastFilter?: MemoryFilter } = {
    async list(filter?: MemoryFilter) { store.lastFilter = filter; return rows },
  }
  return store
}

const repo = () => tmpSourceRepo('orc-grounding-')

describe('createGroundingSource.notes', () => {
  it('returns only the durable grounding family (arch-overview / area-*) as {id,sourceRevision,paths}', async () => {
    const store = fakeStore([
      summaryFixture({ id: 'arch-overview', sourceRevision: 'r1', paths: ['docs/'] }),
      summaryFixture({ id: 'area-memory', sourceRevision: 'r2', paths: ['plugins/memory/'] }),
      summaryFixture({ id: 'area-cli', sourceRevision: null, paths: [] }),
      summaryFixture({ id: 'some-random-fact', sourceRevision: 'r3', paths: ['x.ts'] }),   // not grounding family
      summaryFixture({ id: 'areaxyz', sourceRevision: 'r4', paths: ['y.ts'] }),            // 'area' prefix without dash — excluded
    ])
    const gs = createGroundingSource({ store, dir: '/nowhere' })
    const notes = await gs.notes()
    expect(notes).toEqual([
      { id: 'arch-overview', sourceRevision: 'r1', paths: ['docs/'] },
      { id: 'area-memory', sourceRevision: 'r2', paths: ['plugins/memory/'] },
      { id: 'area-cli', sourceRevision: null, paths: [] },
    ])
  })

  it('lists the project scope, semantic tier — never a note body', async () => {
    const store = fakeStore([])
    await createGroundingSource({ store, dir: '/nowhere' }).notes()
    expect(store.lastFilter).toEqual({ scope: 'project', tier: NOTE_TIER.semantic })
  })

  it('excludes non-semantic tiers even if their id matches the family', async () => {
    const store = fakeStore([
      summaryFixture({ id: 'area-plan', tier: NOTE_TIER.plan, sourceRevision: 'r1', paths: ['a'] }),
    ])
    expect(await createGroundingSource({ store, dir: '/nowhere' }).notes()).toEqual([])
  })
})

describe('createGroundingSource.head', () => {
  it('returns HEAD inside a repo', async () => {
    const r = repo()
    expect(await createGroundingSource({ store: fakeStore([]), dir: r.dir }).head()).toBe(r.head())
  })

  it('returns null outside a repo', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-norepo-'))
    expect(await createGroundingSource({ store: fakeStore([]), dir }).head()).toBeNull()
  })
})

describe('createGroundingSource.commitsSince', () => {
  it('counts declared paths that DIFFER from the working tree — one file, not per commit', async () => {
    const r = repo()
    const base = r.head()
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 2\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'c1')
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 3\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'c2')
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    // a.ts differs from base: ONE changed file, however many commits touched it (working-tree diff)
    expect(await gs.commitsSince(base, ['src/a.ts'])).toBe(1)
  })

  it('catches an UNSTAGED edit the old rev..HEAD probe was blind to — the whole bug fix', async () => {
    const r = repo()
    const base = r.head()
    // edit but do NOT commit — this is exactly how orc drifts a note: it edits source, never commits.
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 99 // uncommitted\n')
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    // `git rev-list base..HEAD` would be 0 (no commits since base) and call the note fresh; the
    // working-tree `git diff base` sees a.ts changed, so the gate correctly calls it stale.
    expect(await gs.commitsSince(base, ['src/a.ts'])).toBe(1)
  })

  it('is 0 (quiet) when nothing touched the paths since the revision', async () => {
    const r = repo()
    const base = r.head()
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 2\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'c1')
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    expect(await gs.commitsSince(base, ['src/b.ts'])).toBe(0)   // b.ts untouched
  })

  it('returns null on ANY failure — unknown revision, no repo', async () => {
    const r = repo()
    expect(await createGroundingSource({ store: fakeStore([]), dir: r.dir }).commitsSince('0'.repeat(40), ['src/a.ts'])).toBeNull()
    const norepo = mkdtempSync(path.join(tmpdir(), 'orc-norepo-'))
    expect(await createGroundingSource({ store: fakeStore([]), dir: norepo }).commitsSince('abc123', ['src/a.ts'])).toBeNull()
  })

  it('caches per (rev, paths) — a repeated verdict spawns no second git', async () => {
    const r = repo()
    const base = r.head()
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    const first = await gs.commitsSince(base, ['src/a.ts'])
    // move the tree AFTER the first call; a cached answer must not see the new commit
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 9\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'later')
    expect(await gs.commitsSince(base, ['src/a.ts'])).toBe(first)   // served from cache
  })
})

describe('createGroundingSource.changedPaths', () => {
  it('returns a file changed since rev that is inside the declared paths', async () => {
    const r = repo()
    const base = r.head()
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 2\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'c1')
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    const changed = await gs.changedPaths(base, ['src/a.ts', 'src/b.ts'])
    expect(changed).toEqual(['src/a.ts'])
  })

  it('does NOT return a file changed outside the declared paths', async () => {
    const r = repo()
    const base = r.head()
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 2\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'c1')
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    // only ask about b.ts — a.ts changed but is outside the declared scope
    const changed = await gs.changedPaths(base, ['src/b.ts'])
    expect(changed).toEqual([])
  })

  it('returns [] (not null, not the declared paths) when nothing changed', async () => {
    const r = repo()
    const base = r.head()
    // no further commits — nothing changed
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    const changed = await gs.changedPaths(base, ['src/a.ts', 'src/b.ts'])
    expect(changed).toEqual([])
  })

  it('returns null on unknown revision', async () => {
    const r = repo()
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    expect(await gs.changedPaths('0'.repeat(40), ['src/a.ts'])).toBeNull()
  })

  it('returns null when not in a git repo', async () => {
    const norepo = mkdtempSync(path.join(tmpdir(), 'orc-norepo-'))
    const gs = createGroundingSource({ store: fakeStore([]), dir: norepo })
    expect(await gs.changedPaths('abc123', ['src/a.ts'])).toBeNull()
  })

  it('caches per (rev, paths) — a repeated call spawns git only once', async () => {
    const r = repo()
    const base = r.head()
    const gs = createGroundingSource({ store: fakeStore([]), dir: r.dir })
    const first = await gs.changedPaths(base, ['src/a.ts'])
    // make a new commit AFTER the first call — a cached answer must not see it
    writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 9\n')
    r.run('add', '-A'); r.run('commit', '-qm', 'later')
    expect(await gs.changedPaths(base, ['src/a.ts'])).toEqual(first)  // served from cache
  })
})
