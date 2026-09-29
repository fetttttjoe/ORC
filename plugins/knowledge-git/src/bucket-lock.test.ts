import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { breakerOf, breakStale, createBucketLocks, lockFileOf } from './bucket-lock'

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
  it('a holder that outlived staleMs never deletes the lock a later writer took', async () => {
    const dir = lockDir()
    const options = { staleMs: 50, retryMs: 5, timeoutMs: 2_000, dir }
    const lock = lockFileOf('/x/d.md', dir)
    const releaseSlow = Promise.withResolvers<void>()
    const slowDone = createBucketLocks(options).withLocks(['/x/d.md'], () => releaseSlow.promise)
    await Bun.sleep(120)
    const fastInside = Promise.withResolvers<void>()
    const releaseFast = Promise.withResolvers<void>()
    const fastDone = createBucketLocks(options).withLocks(['/x/d.md'], async () => { fastInside.resolve(); await releaseFast.promise })
    await fastInside.promise
    releaseSlow.resolve()
    await slowDone
    expect(existsSync(lock)).toBe(true)
    releaseFast.resolve()
    await fastDone
    expect(existsSync(lock)).toBe(false)
  })
  it('leaves a stale lock alone while another process is breaking it', async () => {
    const dir = lockDir()
    const lock = lockFileOf('/x/e.md', dir)
    writeFileSync(lock, 'crashed-writer')
    writeFileSync(breakerOf(lock), 'another-breaker')
    const past = new Date(Date.now() - 60_000)
    utimesSync(lock, past, past)
    await expect(createBucketLocks({ staleMs: 1_000, retryMs: 5, timeoutMs: 100, dir }).withLocks(['/x/e.md'], async () => 1))
      .rejects.toThrow('locked by another writer')
    expect(readFileSync(lock, 'utf8')).toBe('crashed-writer')
  })
  it('clears a breaker left by a crashed breaker, then breaks the stale lock', async () => {
    const dir = lockDir()
    const lock = lockFileOf('/x/f.md', dir)
    writeFileSync(lock, 'crashed-writer')
    writeFileSync(breakerOf(lock), 'crashed-breaker')
    const past = new Date(Date.now() - 60_000)
    utimesSync(lock, past, past)
    utimesSync(breakerOf(lock), past, past)
    expect(await createBucketLocks({ staleMs: 1_000, retryMs: 5, timeoutMs: 2_000, dir }).withLocks(['/x/f.md'], async () => 'ran')).toBe('ran')
  })
  it('times out instead of spinning on a lock path it can neither create nor read', async () => {
    const dir = lockDir()
    symlinkSync(path.join(dir, 'nowhere'), lockFileOf('/x/g.md', dir))
    await expect(createBucketLocks({ staleMs: 1_000, retryMs: 5, timeoutMs: 50, dir }).withLocks(['/x/g.md'], async () => 1))
      .rejects.toThrow('locked by another writer')
  })
  it('never breaks a stale lock whose token is not the one it judged', () => {
    const dir = lockDir()
    const lock = lockFileOf('/x/h.md', dir)
    writeFileSync(lock, 'later-writer')
    const past = new Date(Date.now() - 60_000)
    utimesSync(lock, past, past)
    expect(breakStale(lock, 'judged-writer', 1_000)).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe('later-writer')
    expect(existsSync(breakerOf(lock))).toBe(false)
  })
  it('never breaks a lock holding the judged token once it is no longer stale', () => {
    const dir = lockDir()
    const lock = lockFileOf('/x/i.md', dir)
    writeFileSync(lock, 'judged-writer')
    expect(breakStale(lock, 'judged-writer', 60_000)).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe('judged-writer')
    expect(existsSync(breakerOf(lock))).toBe(false)
  })
})
