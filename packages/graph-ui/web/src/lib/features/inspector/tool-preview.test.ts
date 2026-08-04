import { describe, expect, it } from 'bun:test'
import { toolPreview } from './tool-preview'

describe('toolPreview (a collapsed tool row says what it did)', () => {
  it('picks the identifying field for the shipped tools', () => {
    expect(toolPreview({ path: 'packages/cli/src/runtime.ts' })).toBe('packages/cli/src/runtime.ts')
    expect(toolPreview({ command: 'bun test packages/kernel' })).toBe('bun test packages/kernel')
    expect(toolPreview({ query: 'write zone fence' })).toBe('write zone fence')
    expect(toolPreview({ seed: 'area-memory', depth: 2 })).toBe('area-memory')
  })

  it('prefers the more specific field when a call carries several', () => {
    // fs_read sends {path}; a memory write sends {id,title} — path wins over id, id over title,
    // so sibling rows differ by the thing that actually distinguishes them
    expect(toolPreview({ id: 'x', path: 'a/b.ts' })).toBe('a/b.ts')
    expect(toolPreview({ title: 'Auth flow', id: 'auth-flow' })).toBe('auth-flow')
  })

  it('falls back to the KEY NAMES for a tool it has never seen', () => {
    // never the values: an unknown tool may be sending a whole file body, and a kilobyte of prose
    // in a one-line summary is worse than no preview at all
    expect(toolPreview({ zork: 'x'.repeat(5_000) })).toBe('zork')
    expect(toolPreview({ alpha: 1, beta: 2 })).toBe('alpha beta')
  })

  it('clips a long value and never exceeds the row budget', () => {
    const long = toolPreview({ path: `src/${'deep/'.repeat(40)}file.ts` })
    expect(long.length).toBeLessThanOrEqual(72)
    expect(long.endsWith('…')).toBe(true)
  })

  it('yields nothing rather than noise for an empty or unusable input', () => {
    // no preview is fine — the row still carries the tool name and iteration
    expect(toolPreview({})).toBe('')
    expect(toolPreview(null)).toBe('')
    expect(toolPreview(undefined)).toBe('')
    expect(toolPreview(42)).toBe('')
  })

  it('names the key when its value is empty — "there was a path, and it was blank"', () => {
    // an empty identifying value is not a missing field: falling through to the key name says the
    // call HAD a path and sent nothing, which is exactly the row worth expanding
    expect(toolPreview({ path: '' })).toBe('path')
  })
})
