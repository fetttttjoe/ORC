import { describe, expect, it } from 'bun:test'
import { ClaimClass, ClaimState, KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, type ClaimDrift, type DriftFilterInput } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { suspectAtFor } from './suspect-at'

const drift = (id: string, state: ClaimState): ClaimDrift => ({
  claim: { id, text: 'T.', class: ClaimClass.fact, anchors: [], tags: [], sources: [], decision: null, location: `knowledge/${id}.md` },
  state, basis: null, anchors: [],
})

const accessOver = (answer: (filter: DriftFilterInput) => ClaimDrift[]) => {
  const asked: DriftFilterInput[] = []
  const drifted = async (_call: unknown, filter: DriftFilterInput = {}): Promise<ClaimDrift[]> => { asked.push(filter); return answer(filter) }
  return { asked, access: { port: { drift: drifted } } }
}

describe('suspectAtFor', () => {
  it('keeps only suspect claims, deduped by id, as id + location refs', async () => {
    const { access } = accessOver(() => [drift('aaaaaaaa', ClaimState.suspect), drift('bbbbbbbb', ClaimState.clean), drift('aaaaaaaa', ClaimState.suspect), drift('cccccccc', ClaimState.unknown)])
    const suspectAt = suspectAtFor(access, authorFixture())
    expect(await suspectAt?.(['src/a.ts'])).toEqual([{ id: 'aaaaaaaa', location: 'knowledge/aaaaaaaa.md' }])
  })

  it('splits a commit larger than the filter cap into capped drift reads', async () => {
    const { access, asked } = accessOver(() => [])
    const paths = Array.from({ length: KNOWLEDGE_LIMITS.patchItems * 2 + 1 }, (_, i) => `src/f${i}.ts`)
    await suspectAtFor(access, authorFixture())?.(paths)
    expect(asked.map(f => f.paths?.length)).toEqual([KNOWLEDGE_LIMITS.patchItems, KNOWLEDGE_LIMITS.patchItems, 1])
  })

  it('is absent when knowledge is unavailable', () => {
    expect(suspectAtFor({ unavailable: KNOWLEDGE_REFUSAL.off() }, authorFixture())).toBeUndefined()
  })
})
