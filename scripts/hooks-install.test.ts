import { describe, expect, it } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { GIT_HOOK_NAMES, hookNames } from './hooks-install'

const HOOKS_DIR = path.join(import.meta.dir, 'hooks')

describe('hookNames (which files are hooks, and which merely live beside them)', () => {
  it('claims a name only when git would actually invoke it', () => {
    expect(hookNames(['commit-msg.sh', 'post-commit.sh'])).toEqual(['commit-msg', 'post-commit'])
    expect(hookNames(['post-commit.ts'])).toEqual(['post-commit'])
  })

  it('ignores helper modules and their tests that merely sit in the same directory', () => {
    expect(hookNames(['post-commit-append.ts', 'post-commit-paths.ts', 'post-commit-paths.test.ts'])).toEqual([])
  })

  it('ignores a misspelled hook, so it stays visibly dead instead of silently ignored', () => {
    expect(hookNames(['post-comit.sh'])).toEqual([])
    expect(GIT_HOOK_NAMES).toContain('post-commit')
  })
})

describe('the hooks directory as it stands', () => {
  /** invoking via `sh <file>` cannot see the mode bit, so this asserts the real directory */
  it('every dispatcher is executable, and nothing else is', () => {
    const entries = readdirSync(HOOKS_DIR)
    const executable = (f: string): boolean => (statSync(path.join(HOOKS_DIR, f)).mode & 0o111) !== 0
    const dispatchers = hookNames(entries)

    for (const d of dispatchers)
      expect(executable(d), `${d} is a dispatcher and must be executable — run: bun run hooks:install`).toBe(true)

    // the logic and helper files stay plain: an agent authors those, and fs_write cannot set a mode
    const plain = entries.filter(e => !dispatchers.includes(e))
    for (const f of plain)
      expect(executable(f), `${f} is logic, not a dispatcher — it must not carry the executable bit`).toBe(false)
  })
})
