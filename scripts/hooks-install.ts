// Adds and chmods dispatchers for hook logic files; run `bun run hooks:install` after adding a hook
import { chmodSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const HOOKS_DIR = path.join(import.meta.dir, 'hooks')
// the template copied per hook name; the mode bit is the part an agent cannot produce
const TEMPLATE = path.join(HOOKS_DIR, 'commit-msg')
const EXECUTABLE = 0o755

/** A whitelist, not a filename pattern: a typo like `post-comit.sh` stays visibly dead */
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
    // never clobber: an existing dispatcher is only re-chmodded, so a hand-edited one survives
    let exists = true
    try { statSync(dispatcher) } catch { exists = false }
    if (!exists) { copyFileSync(TEMPLATE, dispatcher); added += 1 }
    chmodSync(dispatcher, EXECUTABLE)
  }
  console.log(`hooks: ${names.length} dispatcher(s) executable (${added} created) — ${names.join(', ')}`)
  console.log('if git is not pointed here yet: git config core.hooksPath scripts/hooks')
}
