import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

// "Has the working tree changed?" as ONE cheap value, shared by every consumer that caches against
// it. HEAD plus the porcelain status covers both halves: a commit moves HEAD, and any tracked or
// untracked edit moves the status.
//
// Two consumers, one spelling on purpose. exec's reuse bracket asks whether an identical command
// may return its recorded result; the memory health probe asks whether a drift verdict may be
// reused. Both mean the same thing by "the tree has not moved", and a second copy of this is
// exactly the duplication that let foldMemory and the Surreal projector answer one question two
// ways for weeks.
//
// COST: two git subprocesses, measured at ~10ms on a 100k-file-history repo — against the 336ms of
// per-revision `git diff` calls a full drift recomputation costs, which is what makes caching on
// this worth doing at all.
//
// null is NOT a fingerprint. A directory that is not a repo, or a git that failed, yields null, and
// every consumer must treat null as "cannot cache" rather than as a stable key — with nothing to
// invalidate against, a hit could serve a result for a tree that has completely changed.

// Never the orchestrator's full env: this runs git, but the same child-env policy applies as
// everywhere else a subprocess is spawned — provider keys and DB credentials do not travel.
const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'])
    if (process.env[k] !== undefined) out[k] = process.env[k]
  return out
}

const gitStdout = (dir: string, args: readonly string[]): Promise<string | null> =>
  new Promise(resolve => {
    try {
      const c = spawn('git', ['-C', dir, ...args], { env: childEnv() })
      let out = ''
      c.stdout.setEncoding('utf8')
      c.stdout.on('data', d => { out += d })
      c.on('error', () => resolve(null))
      c.on('close', code => resolve(code === 0 ? out : null))
    } catch { resolve(null) }
  })

/** A hash of (HEAD, porcelain status), or null when the directory cannot be fingerprinted. */
export async function treeFingerprint(dir: string): Promise<string | null> {
  const [head, status] = await Promise.all([
    gitStdout(dir, ['rev-parse', 'HEAD']),
    gitStdout(dir, ['status', '--porcelain']),
  ])
  if (head === null || status === null) return null
  // JSON-encoded rather than joined on a separator. The pair must hash injectively, and every
  // separator worth using is a control character: a literal one makes the whole source file
  // binary to grep, and a search that silently finds nothing is worse than one that fails.
  return createHash('sha256').update(JSON.stringify([head, status])).digest('hex')
}
