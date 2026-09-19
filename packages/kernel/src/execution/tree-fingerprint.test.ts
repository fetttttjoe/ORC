import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sh, tmpGitRepo } from '../test-helpers'
import { treeFingerprint } from './tree-fingerprint'

const temps: string[] = []
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

const repo = (): string => {
  const { main } = tmpGitRepo()
  temps.push(path.dirname(main))
  return main
}

describe('treeFingerprint follows content, not just which paths are dirty', () => {
  it('changes on a SECOND edit to an already-modified tracked file', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'README'), 'first edit\n')
    const first = await treeFingerprint(dir)
    writeFileSync(path.join(dir, 'README'), 'second edit\n')
    const second = await treeFingerprint(dir)
    expect(first).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it('changes when a staged file is edited again in the worktree', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'README'), 'staged\n')
    sh(dir, 'add', 'README')
    const staged = await treeFingerprint(dir)
    writeFileSync(path.join(dir, 'README'), 'staged then edited\n')
    expect(await treeFingerprint(dir)).not.toBe(staged)
  })

  it('changes when the content of an untracked file changes', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'scratch.txt'), 'one\n')
    const before = await treeFingerprint(dir)
    writeFileSync(path.join(dir, 'scratch.txt'), 'two\n')
    expect(await treeFingerprint(dir)).not.toBe(before)
  })

  it('is stable when nothing changes', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'README'), 'edited\n')
    writeFileSync(path.join(dir, 'scratch.txt'), 'one\n')
    expect(await treeFingerprint(dir)).toBe(await treeFingerprint(dir))
  })

  it('is stable when an ignored file changes', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, '.gitignore'), 'noise.log\n')
    sh(dir, 'add', '.gitignore')
    sh(dir, 'commit', '-q', '-m', 'ignore noise')
    writeFileSync(path.join(dir, 'noise.log'), 'one\n')
    const before = await treeFingerprint(dir)
    writeFileSync(path.join(dir, 'noise.log'), 'two\n')
    expect(await treeFingerprint(dir)).toBe(before)
  })

  it('still fingerprints a tree holding an untracked file whose name contains a newline', async () => {
    const dir = repo()
    writeFileSync(path.join(dir, 'weird\nname.txt'), 'one\n')
    const withFile = await treeFingerprint(dir)
    expect(withFile).not.toBeNull()
    rmSync(path.join(dir, 'weird\nname.txt'))
    expect(await treeFingerprint(dir)).not.toBe(withFile)
  })

  it('returns null outside a repository', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-nogit-'))
    temps.push(dir)
    expect(await treeFingerprint(dir)).toBeNull()
  })
})
