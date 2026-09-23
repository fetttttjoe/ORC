import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { TreeStamps } from '@orc/contracts'

// Argument arrays, never a shell string: a path is data and a checkout directory is data.
const git = async (dir: string, args: readonly string[]): Promise<string | null> => {
  try {
    const proc = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 && out.trim() !== '' ? out.trim() : null
  } catch {
    return null
  }
}

// A stamp names a file of THIS checkout. `..`, an absolute path and a symlink pointing out of the
// tree all address something else, and hashing it would file another tree's content as evidence.
const insideCheckout = async (dir: string, file: string): Promise<boolean> => {
  if (path.isAbsolute(file) || file.split(/[/\\]/).includes('..')) return false
  const root = await realpath(dir).catch(() => null)
  const resolved = await realpath(path.resolve(dir, file)).catch(() => null)
  if (root === null || resolved === null) return false
  return resolved === root || resolved.startsWith(root + path.sep)
}

// The two stamps read from ONE checkout, both null when git cannot answer.
export const treeStamps = (dir: string): TreeStamps => ({
  revision: () => git(dir, ['rev-parse', 'HEAD']),
  blob: async file =>
    (await insideCheckout(dir, file)) ? git(dir, ['hash-object', '--no-filters', '--', file]) : null,
})
