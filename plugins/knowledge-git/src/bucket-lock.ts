import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codeOf, Errno } from './error-code'

export interface LockOptions { staleMs: number; retryMs: number; timeoutMs: number; dir: string }
export const DEFAULT_LOCK_OPTIONS: LockOptions = { staleMs: 30_000, retryMs: 25, timeoutMs: 10_000, dir: path.join(tmpdir(), 'orc-knowledge-locks') }

export const lockFileOf = (file: string, dir: string): string =>
  path.join(dir, `${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32)}.lock`)
export const breakerOf = (lock: string): string => `${lock}.break`

const tokenIn = (file: string): string | null => {
  try { return readFileSync(file, 'utf8') } catch (err) {
    if (codeOf(err) === Errno.ENOENT) return null
    throw err
  }
}
const ageOf = (file: string): number | null => {
  const stat = statSync(file, { throwIfNoEntry: false })
  return stat === undefined ? null : Date.now() - stat.mtimeMs
}
const createHeld = (file: string, token: string): boolean => {
  try {
    const fd = openSync(file, 'wx')
    try { writeSync(fd, token) } finally { closeSync(fd) }
    return true
  } catch (err) {
    if (codeOf(err) === Errno.EEXIST) return false
    throw err
  }
}
const releaseHeld = (file: string, token: string): void => {
  if (tokenIn(file) === token) rmSync(file, { force: true })
}
const isStale = (file: string, staleMs: number): boolean => (ageOf(file) ?? 0) > staleMs

export const breakStale = (lock: string, judged: string | null, staleMs: number): boolean => {
  const breaker = breakerOf(lock)
  const mine = randomUUID()
  if (!createHeld(breaker, mine)) {
    if (isStale(breaker, staleMs)) rmSync(breaker, { force: true })
    return false
  }
  try {
    if (tokenIn(lock) !== judged || !isStale(lock, staleMs)) return false
    rmSync(lock, { force: true })
    return true
  } finally { releaseHeld(breaker, mine) }
}

export interface BucketLocks { withLocks<T>(files: readonly string[], fn: () => Promise<T>): Promise<T> }

export function createBucketLocks(options: LockOptions = DEFAULT_LOCK_OPTIONS): BucketLocks {
  const chains = new Map<string, Promise<void>>()

  const acquireFile = async (file: string): Promise<() => void> => {
    mkdirSync(options.dir, { recursive: true })
    const lock = lockFileOf(file, options.dir)
    const token = randomUUID()
    const deadline = Date.now() + options.timeoutMs
    for (;;) {
      if (createHeld(lock, token)) return () => releaseHeld(lock, token)
      const judged = tokenIn(lock)
      if (isStale(lock, options.staleMs) && breakStale(lock, judged, options.staleMs)) continue
      if (Date.now() > deadline) throw new Error(`bucket '${file}' is locked by another writer for over ${options.timeoutMs} ms`)
      await Bun.sleep(options.retryMs)
    }
  }

  const withOne = async <T>(file: string, fn: () => Promise<T>): Promise<T> => {
    const prior = chains.get(file) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    const mine = prior.then(() => gate.promise)
    chains.set(file, mine)
    await prior
    try {
      const release = await acquireFile(file)
      try { return await fn() } finally { release() }
    } finally {
      gate.resolve()
      if (chains.get(file) === mine) chains.delete(file)
    }
  }

  return {
    withLocks<T>(files: readonly string[], fn: () => Promise<T>): Promise<T> {
      const ordered = [...new Set(files.map(f => path.resolve(f)))].sort()
      return ordered.reduceRight<() => Promise<T>>((inner, file) => () => withOne(file, inner), fn)()
    },
  }
}
