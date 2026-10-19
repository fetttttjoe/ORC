import { describe, expect, it } from 'bun:test'
import { namedPaths, preloadQuery, zonePrefix } from './preload-request'

describe('namedPaths', () => {
  it('takes a path out of prose, without its line number or trailing punctuation', () => {
    expect(namedPaths('In packages/kernel/src/execution/dbos-port.ts:203, see createDbosPort.')).toEqual(['packages/kernel/src/execution/dbos-port.ts'])
  })
  it('drops a #symbol, keeping the file', () => {
    expect(namedPaths('plugins/memory/src/store.ts#createEventStore')).toEqual(['plugins/memory/src/store.ts'])
  })
  it('ignores a URL and a bare file name', () => {
    expect(namedPaths('https://bun.sh/docs/cli/test')).toEqual([])
    expect(namedPaths('CLAUDE.md')).toEqual([])
  })
  it('collapses duplicates, keeping the first occurrence order', () => {
    expect(namedPaths('Read `src/b.ts`, then src/a.ts and (src/b.ts) again; src/a.ts:4 too.')).toEqual(['src/b.ts', 'src/a.ts'])
  })
})

describe('zonePrefix', () => {
  it('is the static folder in front of the first glob character', () => {
    expect(zonePrefix('packages/kernel/src/**')).toBe('packages/kernel/src')
    expect(zonePrefix('packages/kernel/src/execution/*.ts')).toBe('packages/kernel/src/execution')
  })
  it('is the path itself when it holds no glob character', () => {
    expect(zonePrefix('src/a.ts')).toBe('src/a.ts')
  })
  it('is nothing for a glob with no static folder', () => {
    expect(zonePrefix('**/*.ts')).toBeNull()
  })
})

describe('preloadQuery', () => {
  it('is the title and the instructions on two lines, cut to the limit', () => {
    expect(preloadQuery('A', 'B', 600)).toBe('A\nB')
    expect(preloadQuery('x'.repeat(400), 'y'.repeat(400), 600)).toBe(`${'x'.repeat(400)}\n${'y'.repeat(199)}`)
  })
})
