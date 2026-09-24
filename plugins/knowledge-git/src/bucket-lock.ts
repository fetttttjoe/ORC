import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codeOf } from './error-code'

export interface LockOptions { staleMs: number; retryMs: number; timeoutMs: number; dir: string }
export const DEFAULT_LOCK_OPTIONS: LockOptions = { staleMs: 30_000, retryMs: 25, timeoutMs: 10_000, dir: path.join(tmpdir(), 'orc-knowledge-locks') }

export const lockFileOf = (file: string, dir: string): string =>
  path.join(dir, `${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32)}.lock`)

export function createBucketLocks(options: LockOptions = DEFAULT_LOCK_OPTIONS) {
  const chains = new Map<string, Promise<void>>()

  const acquireFile = async (file: string): Promise<() => void> => {
    mkdirSync(options.dir, { recursive: true })
    const lock = lockFileOf(file, options.dir)
    const deadline = Date.now() + options.timeoutMs
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'))
        return () => rmSync(lock, { force: true })
      } catch (err) {
        if (codeOf(err) !== 'EEXIST') throw err
      }
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > options.staleMs) { rmSync(lock, { force: true }); continue }
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
