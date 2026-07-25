import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDriftProbe, noteHasDrifted } from './drift'

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
