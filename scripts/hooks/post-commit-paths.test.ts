import { describe, expect, it } from 'bun:test'
import { parseChangedPaths } from './post-commit-paths'

/** The pure half of the post-commit hook: plumbing text in, path list out */
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
