import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { childEnv } from './child-env'

const NUL = '\u0000'
const HASH = 'sha256'

type Consume<T> = { onData: (chunk: Buffer) => void; result: () => T }

const runGit = <T>(dir: string, args: readonly string[], stdin: string, consume: Consume<T>): Promise<T | null> =>
  new Promise(resolve => {
    try {
      const c = spawn('git', ['-C', dir, ...args], { env: childEnv() })
      c.stdout.on('data', consume.onData)
      c.on('error', () => resolve(null))
      c.on('close', code => resolve(code === 0 ? consume.result() : null))
      c.stdin.on('error', () => {})
      c.stdin.end(stdin)
    } catch { resolve(null) }
  })

const gitText = (dir: string, args: readonly string[], stdin = ''): Promise<string | null> => {
  const chunks: Buffer[] = []
  return runGit(dir, args, stdin, { onData: c => { chunks.push(c) }, result: () => Buffer.concat(chunks).toString('utf8') })
}

// streamed: a binary diff can be tens of megabytes and this runs before every exec
const gitDigest = (dir: string, args: readonly string[]): Promise<string | null> => {
  const hash = createHash(HASH)
  return runGit(dir, args, '', { onData: c => { hash.update(c) }, result: () => hash.digest('hex') })
}

const untrackedContents = async (dir: string): Promise<string | null> => {
  const listed = await gitText(dir, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (listed === null) return null
  const paths = listed.split(NUL).filter(p => p !== '')
  // hash-object reads one path per line, so a name holding a newline is tracked by name only
  const hashable = paths.filter(p => !p.includes('\n'))
  if (hashable.length === 0) return JSON.stringify([paths, ''])
  const hashes = await gitText(dir, ['hash-object', '--stdin-paths'], `${hashable.join('\n')}\n`)
  if (hashes === null) return null
  return JSON.stringify([paths, hashes])
}

/** Hash of HEAD, tracked changes and untracked files BY CONTENT; null means "cannot cache". */
export async function treeFingerprint(dir: string): Promise<string | null> {
  const [head, tracked, untracked] = await Promise.all([
    gitText(dir, ['rev-parse', 'HEAD']),
    gitDigest(dir, ['diff', 'HEAD', '--binary']),
    untrackedContents(dir),
  ])
  if (head === null || tracked === null || untracked === null) return null
  return createHash(HASH).update(JSON.stringify([head, tracked, untracked])).digest('hex')
}
