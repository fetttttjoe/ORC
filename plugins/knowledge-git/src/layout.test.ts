import { describe, expect, it } from 'bun:test'
import { bucketOf, isBucket, packageRootOf, titleOf } from './layout'

const roots = ['.', 'packages/kernel', 'plugins/memory', 'packages/graph-ui', 'packages/graph-ui/web']
const file = (path: string) => ({ path, isDirectory: false })
const dir = (path: string) => ({ path, isDirectory: true })

describe('packageRootOf', () => {
  it('picks the deepest manifest folder, segment-wise', () => {
    expect(packageRootOf('packages/graph-ui/web/src/app.ts', roots)).toBe('packages/graph-ui/web')
    expect(packageRootOf('packages/kernelx/a.ts', roots)).toBe('.')
    expect(packageRootOf('docs/guide.md', roots)).toBe('.')
  })
})

describe('bucketOf', () => {
  it.each([
    [file('plugins/memory/src/store.ts'), 'plugins/memory/knowledge/src/store.ts.md'],
    [file('packages/graph-ui/web/src/app.svelte'), 'packages/graph-ui/web/knowledge/src/app.svelte.md'],
    [file('scripts/check-web.ts'), 'knowledge/scripts/check-web.ts.md'],
    [file('README.md'), 'knowledge/README.md.md'],
    [dir('plugins/memory'), 'plugins/memory/knowledge/README.md'],
    [dir('plugins/memory/src'), 'plugins/memory/knowledge/README.md'],
    [dir('docs'), 'knowledge/README.md'],
  ])('%p lives in %p', (anchor, expected) => {
    expect(bucketOf(anchor, roots, 'knowledge')).toBe(expected)
  })
  it('an unanchored claim lives in the root README', () => {
    expect(bucketOf(null, roots, 'knowledge')).toBe('knowledge/README.md')
  })
  it('honours another folder name', () => {
    expect(bucketOf(file('plugins/memory/src/a.ts'), roots, 'kb')).toBe('plugins/memory/kb/src/a.ts.md')
  })
})

describe('isBucket and titleOf', () => {
  it('a bucket sits directly in its own package knowledge folder', () => {
    expect(isBucket('plugins/memory/knowledge/src/store.ts.md', roots, 'knowledge')).toBe(true)
    expect(isBucket('knowledge/README.md', roots, 'knowledge')).toBe(true)
    expect(isBucket('plugins/memory/src/knowledge/notes.md', roots, 'knowledge')).toBe(false)
    expect(isBucket('plugins/memory/README.md', roots, 'knowledge')).toBe(false)
  })
  it('a package named like the folder still resolves', () => {
    const withCore = [...roots, 'packages/knowledge']
    expect(isBucket('packages/knowledge/README.md', withCore, 'knowledge')).toBe(false)
    expect(isBucket('packages/knowledge/knowledge/src/port.ts.md', withCore, 'knowledge')).toBe(true)
    expect(titleOf('packages/knowledge/knowledge/src/port.ts.md', withCore, 'knowledge')).toBe('packages/knowledge/src/port.ts')
  })
  it('titles name the code file, the package, or the project', () => {
    expect(titleOf('plugins/memory/knowledge/src/store.ts.md', roots, 'knowledge')).toBe('plugins/memory/src/store.ts')
    expect(titleOf('plugins/memory/knowledge/README.md', roots, 'knowledge')).toBe('plugins/memory')
    expect(titleOf('knowledge/README.md', roots, 'knowledge')).toBe('project')
    expect(titleOf('knowledge/README.md.md', roots, 'knowledge')).toBe('README.md')
  })
})
