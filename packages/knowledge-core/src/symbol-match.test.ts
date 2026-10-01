import { describe, expect, it } from 'bun:test'
import { STRUCTURE_LIMITS } from '@orc/contracts'
import { matchSymbol } from './symbol-match'

const limit = STRUCTURE_LIMITS.closestNames

describe('matchSymbol', () => {
  it('an exact qualified name wins, even over a unique suffix', () => {
    expect(matchSymbol(['Kernel', 'Kernel.append', 'makeOps.append'], 'Kernel.append', limit)).toEqual({ name: 'Kernel.append' })
    expect(matchSymbol(['append', 'makeOps.append'], 'append', limit)).toEqual({ name: 'append' })
  })

  it('a unique name ending in .<wanted> wins, repeated occurrences counting once', () => {
    const names = ['buildRuntime', 'buildRuntime.port', 'buildRuntime.port.stepTools', 'f.mystepTools', 'f.x', 'f.x']
    expect(matchSymbol(names, 'stepTools', limit)).toEqual({ name: 'buildRuntime.port.stepTools' })
    expect(matchSymbol(names, 'port.stepTools', limit)).toEqual({ name: 'buildRuntime.port.stepTools' })
    expect(matchSymbol(names, 'x', limit)).toEqual({ name: 'f.x' })
  })

  it('an ambiguous suffix lists its candidates first', () => {
    expect(matchSymbol(['x.appen', 'b.x.append', 'a.x.append'], 'x.append', limit))
      .toEqual({ closest: ['a.x.append', 'b.x.append', 'x.appen'] })
  })

  it('a typo lists the closest names by full name or last part, ties by name, up to the limit', () => {
    const names = ['beta', 'alpha', 'gamma2', 'f.gamma']
    expect(matchSymbol(names, 'gamna', limit)).toEqual({ closest: ['f.gamma', 'gamma2', 'alpha', 'beta'] })
    expect(matchSymbol(names, 'gamna', 2)).toEqual({ closest: ['f.gamma', 'gamma2'] })
  })

  it('no names leaves nothing to suggest', () => {
    expect(matchSymbol([], 'anything', limit)).toEqual({ closest: [] })
  })
})
