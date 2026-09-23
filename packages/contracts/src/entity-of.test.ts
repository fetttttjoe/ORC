import { describe, expect, it } from 'bun:test'
import { entitiesOf, entityChain, ROOT_ENTITY, underEntity } from './entity-of'

const packages = ['packages/kernel', 'plugins/memory', 'packages/graph-ui', 'packages/graph-ui/web']

describe('entityChain', () => {
  it('a source file belongs to itself, its package and the root', () => {
    expect(entityChain('packages/kernel/src/finish-step.ts', packages)).toEqual([
      'packages/kernel/src/finish-step.ts',
      'packages/kernel',
      ROOT_ENTITY,
    ])
  })
  it('normalises ./, backslashes and a trailing slash', () => {
    expect(entityChain('./plugins\\memory/src/card.ts/', packages)).toEqual([
      'plugins/memory/src/card.ts',
      'plugins/memory',
      ROOT_ENTITY,
    ])
  })
  it('a path no deeper than a package has no package above it', () => {
    expect(entityChain('docs/ARCHITECTURE.md', packages)).toEqual(['docs/ARCHITECTURE.md', ROOT_ENTITY])
    expect(entityChain('packages/kernel', packages)).toEqual(['packages/kernel', ROOT_ENTITY])
  })
  it('retains nested workspace packages, most specific first', () => {
    expect(entityChain('packages/graph-ui/web/src/app.ts', packages)).toEqual([
      'packages/graph-ui/web/src/app.ts',
      'packages/graph-ui/web',
      'packages/graph-ui',
      ROOT_ENTITY,
    ])
  })
  it('does not invent a package for a deep documentation path', () => {
    expect(entityChain('docs/research/topic/result.md', packages)).toEqual([
      'docs/research/topic/result.md',
      ROOT_ENTITY,
    ])
  })
  it('an empty path is the root', () => expect(entityChain('', packages)).toEqual([ROOT_ENTITY]))
})

describe('entitiesOf / underEntity', () => {
  it('unions the chains of every anchor without duplicates', () => {
    expect(entitiesOf([{ path: 'packages/kernel/src/a.ts' }, { path: 'packages/kernel/src/b.ts' }], packages))
      .toEqual(['packages/kernel/src/a.ts', 'packages/kernel', ROOT_ENTITY, 'packages/kernel/src/b.ts'])
  })
  it('containment is by path segment, never by string prefix', () => {
    expect(underEntity('packages/kernel', 'packages/kernel/src/a.ts')).toBe(true)
    expect(underEntity('packages/kern', 'packages/kernel/src/a.ts')).toBe(false)
    expect(underEntity(ROOT_ENTITY, 'anything/at/all.ts')).toBe(true)
  })
})
