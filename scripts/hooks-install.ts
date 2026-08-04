// Refresh the executable dispatchers in scripts/hooks/ from the logic files beside them.
//
// git execs a hook file DIRECTLY and only if it is executable, so the mode bit is load-bearing —
// and it is the one thing an agent cannot produce (fs_write creates 0644 by design; granting it
// more would let an agent plant an executable under .git/hooks and bypass the exec allowlist).
// Splitting permission from behaviour is what makes hooks authorable: this script owns the
// privileged half, and every hook's logic is a plain sibling file anyone can write.
//
// Idempotent, and safe to run any time — it only ever adds a dispatcher for a logic file that has
// none, and re-asserts the mode on those it manages. Run it after adding a new hook NAME:
//   bun run hooks:install
// Pointing git at the directory stays a separate one-time step (CONTRIBUTING documents it):
//   git config core.hooksPath scripts/hooks
import { chmodSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const HOOKS_DIR = path.join(import.meta.dir, 'hooks')
// the dispatcher every hook name gets a copy of — itself a hook file, so it is the template too
const TEMPLATE = path.join(HOOKS_DIR, 'commit-msg')
const EXECUTABLE = 0o755

/**
 * The hook names git will ever invoke. A WHITELIST, not a filename pattern: helpers live in this
 * directory too, and inferring names from extensions gave `post-commit-append.ts` and
 * `post-commit-paths.ts` dispatchers of their own on the first run of this script. It also means a
 * typo — `post-comit.sh` — gets no dispatcher and stays visibly dead rather than silently ignored.
 *
 * Client-side hooks only. Server-side ones (pre-receive, update, post-receive) never run from a
 * working clone, so shipping dispatchers for them would be noise.
 */
export const GIT_HOOK_NAMES: readonly string[] = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch',
  'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite',
  'pre-auto-gc', 'push-to-checkout', 'sendemail-validate',
]

/** hook names with logic beside them: `post-commit.sh` or `post-commit.ts` implies `post-commit` */
export function hookNames(entries: readonly string[]): string[] {
  const names = new Set<string>()
  for (const e of entries) {
    const m = /^(.+)\.(sh|ts)$/.exec(e)
    if (m?.[1] !== undefined && GIT_HOOK_NAMES.includes(m[1])) names.add(m[1])
  }
  return [...names].sort()
}

if (import.meta.main) {
  const entries = readdirSync(HOOKS_DIR)
  const names = hookNames(entries)
  let added = 0
  for (const name of names) {
    const dispatcher = path.join(HOOKS_DIR, name)
    // never clobber content: a dispatcher already present is only re-chmodded, so a hand-edited one
    // survives. Only the MODE is this script's business.
    let exists = true
    try { statSync(dispatcher) } catch { exists = false }
    if (!exists) { copyFileSync(TEMPLATE, dispatcher); added += 1 }
    chmodSync(dispatcher, EXECUTABLE)
  }
  console.log(`hooks: ${names.length} dispatcher(s) executable (${added} created) — ${names.join(', ')}`)
  console.log('if git is not pointed here yet: git config core.hooksPath scripts/hooks')
}
