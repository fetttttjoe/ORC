import { describe, expect, it } from 'bun:test'
import { ClaimClass, ClaimState, PreloadArm, type ClaimDrift, type KnowledgeClaim } from '@orc/contracts'
import { matchesDrift } from './drift-filter'
import { assemblePreload } from './preload'
import { preloadArms, type PreloadInputs } from './preload-arms'

const claim = (id: string, ...paths: string[]): KnowledgeClaim => ({
  id, text: `claim ${id}`, class: ClaimClass.fact, anchors: paths.map(path => ({ path, symbol: null })), tags: [], sources: [], decision: null, location: `k/${id}.md`,
})
const kept = (id: string, location: string, path: string): KnowledgeClaim => ({ ...claim(id, path), location })
const drift = (c: KnowledgeClaim): ClaimDrift => ({ claim: c, state: ClaimState.clean, basis: null, anchors: [] })
const inputs = (over: Partial<PreloadInputs>): PreloadInputs => ({ pushed: [], byPath: [], hits: [], stateOf: () => ClaimState.clean, paths: [], ...over })
const ids = (arms: ReturnType<typeof preloadArms>): Record<string, string[]> => Object.fromEntries(arms.map(a => [a.arm, a.claims.map(c => c.id)]))

describe('preloadArms', () => {
  it('a claim at a requested path comes ahead of one under it, and one in a folder above goes around', () => {
    const under = claim('aunder00', 'src/a/b.ts')
    const exact = claim('zexact00', 'src/a')
    const above = claim('above000', 'src')
    const arms = preloadArms(inputs({ byPath: [under, exact, above].map(drift), paths: ['src/a'] }))
    expect(ids(arms)).toEqual({ [PreloadArm.pushed]: [], [PreloadArm.here]: ['zexact00', 'aunder00'], [PreloadArm.around]: ['above000'], [PreloadArm.search]: [] })
  })
  it('places every claim the path read selected, by the rule that selected it', () => {
    const all = [claim('srcfoldr', 'src'), claim('srcfilea', 'src/a.ts'), claim('libfileb', 'lib/b.ts')]
    for (const paths of [['.'], ['src/a.ts'], ['src/a.ts', 'lib']]) {
      const selected = all.filter(c => matchesDrift({ paths }, c))
      const arms = preloadArms(inputs({ byPath: selected.map(drift), paths }))
      const placed = arms.filter(a => a.arm === PreloadArm.here || a.arm === PreloadArm.around).flatMap(a => a.claims.map(c => c.id))
      expect(placed.toSorted()).toEqual(selected.map(c => c.id).toSorted())
    }
  })
  it('search rank breaks a tie, then location; a claim the search missed comes after', () => {
    const missed = claim('aaaaaaaa', 'src/a.ts')
    const second = claim('bbbbbbbb', 'src/b.ts')
    const first = claim('cccccccc', 'src/c.ts')
    const arms = preloadArms(inputs({ byPath: [missed, second, first].map(drift), hits: [first, second], paths: ['src'] }))
    expect(ids(arms)[PreloadArm.here]).toEqual(['cccccccc', 'bbbbbbbb', 'aaaaaaaa'])
  })
  it('two claims the search missed are ordered by where they are kept, before their ids', () => {
    const laterFile = kept('aaaaaaaa', 'k/z.md', 'src/a.ts')
    const earlierFile = kept('zzzzzzzz', 'k/a.md', 'src/b.ts')
    const arms = preloadArms(inputs({ byPath: [laterFile, earlierFile].map(drift), hits: [claim('elsewher', 'lib/x.ts')], paths: ['src'] }))
    expect(ids(arms)[PreloadArm.here]).toEqual(['zzzzzzzz', 'aaaaaaaa'])
  })
  it('inside an arm, clean comes first, then unanchored, unknown and suspect, each keeping its order', () => {
    const [suspect, clean, unknown, unanchored, clean2] = ['s', 'c', 'u', 'n', 'd'].map(l => claim(l.repeat(8)))
    const states = new Map([[suspect.id, ClaimState.suspect], [clean.id, ClaimState.clean], [unknown.id, ClaimState.unknown], [unanchored.id, ClaimState.unanchored], [clean2.id, ClaimState.clean]])
    const arms = preloadArms(inputs({ pushed: [suspect, clean, unknown, unanchored, clean2], stateOf: c => states.get(c.id) ?? ClaimState.clean }))
    expect(ids(arms)[PreloadArm.pushed]).toEqual([clean.id, clean2.id, unanchored.id, unknown.id, suspect.id])
  })
  it('a claim at a path and in the hits is listed in both arms, and assembled into here only', () => {
    const both = claim('bothbath', 'src/a.ts')
    const arms = preloadArms(inputs({ byPath: [drift(both)], hits: [both], paths: ['src/a.ts'] }))
    expect(ids(arms)[PreloadArm.here]).toEqual([both.id])
    expect(ids(arms)[PreloadArm.search]).toEqual([both.id])
    const assembled = assemblePreload(arms.map(a => a.claims.map(c => ({ id: c.id, cost: 1, item: a.arm }))), 100)
    expect(assembled.map(a => a.item)).toEqual([PreloadArm.here])
  })
})
