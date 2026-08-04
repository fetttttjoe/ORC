import { describe, expect, it } from 'bun:test'
import { parseChangedPaths } from './post-commit-paths'

/**
 * The PURE half of the post-commit hook: turns whatever a git plumbing command printed (e.g.
 * `git show --name-only --format= HEAD`, the same spelling commit-tool.ts's committedPaths
 * already uses) into a path list. No git process spawned here, no filesystem access — the hook
 * script owns capturing the raw text; this only owns parsing it, so it is testable with plain
 * strings.
 */
describe('parseChangedPaths', () => {
  it('splits normal multi-line plumbing output into trimmed paths', () => {
    const raw = 'packages/kernel/src/index.ts\npackages/contracts/src/events.ts\nscripts/hooks/post-commit\n'
    expect(parseChangedPaths(raw)).toEqual([
      'packages/kernel/src/index.ts',
      'packages/contracts/src/events.ts',
      'scripts/hooks/post-commit',
    ])
  })

  it('drops a trailing blank line', () => {
    const raw = 'a.ts\nb.ts\n\n'
    expect(parseChangedPaths(raw)).toEqual(['a.ts', 'b.ts'])
  })

  it('drops blank lines in the middle and trims stray whitespace', () => {
    const raw = '  a.ts  \n\nb.ts\n   \nc.ts'
    expect(parseChangedPaths(raw)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('returns [] for empty input', () => {
    expect(parseChangedPaths('')).toEqual([])
  })

  it('returns [] for input that is only whitespace/blank lines', () => {
    expect(parseChangedPaths('\n\n   \n')).toEqual([])
  })
})
