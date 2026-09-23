import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { treeStamps } from './tree-stamps'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const sh = (dir: string, ...cmd: string[]) => Bun.spawn(cmd, { cwd: dir, stdout: 'ignore', stderr: 'ignore' }).exited

async function checkout(contents: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'orc-stamps-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'file.ts'), contents)
  await sh(dir, 'git', 'init', '-q')
  await sh(dir, 'git', 'add', 'file.ts')
  await sh(dir, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', contents)
  return dir
}

describe('treeStamps', () => {
  it('reads the blob and the revision of the checkout it was built for', async () => {
    const [a, b] = await Promise.all([checkout('alpha'), checkout('beta')])
    const [stampsA, stampsB] = [treeStamps(a), treeStamps(b)]
    const [blobA, blobB] = [await stampsA.blob('file.ts'), await stampsB.blob('file.ts')]
    const [revA, revB] = [await stampsA.revision(), await stampsB.revision()]
    expect(blobA).toMatch(/^[0-9a-f]{40}$/)
    expect(blobB).not.toBe(blobA)
    expect(revA).toMatch(/^[0-9a-f]{40}$/)
    expect(revB).not.toBe(revA)
  })

  it('refuses a path that escapes the checkout', async () => {
    const dir = await checkout('alpha')
    const outside = await checkout('elsewhere')
    symlinkSync(path.join(outside, 'file.ts'), path.join(dir, 'link.ts'))
    const stamps = treeStamps(dir)
    expect(await stamps.blob('../file.ts')).toBeNull()
    expect(await stamps.blob(path.join(dir, 'file.ts'))).toBeNull()
    expect(await stamps.blob('link.ts')).toBeNull()
  })

  it('answers null for a file the checkout does not hold, and for a directory that is no repo', async () => {
    const dir = await checkout('alpha')
    expect(await treeStamps(dir).blob('missing.ts')).toBeNull()
    const bare = mkdtempSync(path.join(tmpdir(), 'orc-stamps-'))
    dirs.push(bare)
    expect(await treeStamps(bare).revision()).toBeNull()
  })
})
