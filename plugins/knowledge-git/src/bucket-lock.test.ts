import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBucketLocks, lockFileOf } from './bucket-lock'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const lockDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-klock-')); dirs.push(d); return d }

describe('bucket locks', () => {
  it('serialises writers of one file across two lock sets (two processes)', async () => {
    const dir = lockDir()
    const options = { staleMs: 30_000, retryMs: 5, timeoutMs: 5_000, dir }
    const one = createBucketLocks(options)
    const two = createBucketLocks(options)
    const order: string[] = []
    const hold = (set: typeof one, name: string) => set.withLocks(['/x/a.md'], async () => {
      order.push(`${name}+`); await Bun.sleep(20); order.push(`${name}-`)
    })
    await Promise.all([hold(one, 'a'), hold(two, 'b'), hold(one, 'c')])
    expect(order).toHaveLength(6)
    for (let i = 0; i < order.length; i += 2) expect(order[i]?.[0]).toBe(order[i + 1]?.[0])
  })
  it('breaks a lock older than staleMs', async () => {
    const dir = lockDir()
    const options = { staleMs: 1_000, retryMs: 5, timeoutMs: 2_000, dir }
    const file = lockFileOf('/x/b.md', dir)
    writeFileSync(file, '')
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)
    expect(await createBucketLocks(options).withLocks(['/x/b.md'], async () => 'ran')).toBe('ran')
  })
  it('gives up after timeoutMs on a fresh foreign lock', async () => {
    const dir = lockDir()
    writeFileSync(lockFileOf('/x/c.md', dir), '')
    await expect(createBucketLocks({ staleMs: 60_000, retryMs: 5, timeoutMs: 50, dir }).withLocks(['/x/c.md'], async () => 1))
      .rejects.toThrow('locked by another writer')
  })
})
