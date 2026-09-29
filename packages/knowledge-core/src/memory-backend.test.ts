import { describe, expect, it } from 'bun:test'
import { ClaimClass, DecisionStatus, KnowledgePatch } from '@orc/contracts'
import { describeKnowledgeBackend, CONTRACT_DIRS, CONTRACT_FILES } from './contract-suite'
import { createMemoryBackend } from './memory-backend'

const known = new Set<string>([...CONTRACT_FILES, ...CONTRACT_DIRS])
describeKnowledgeBackend('the in-memory backend', async () => ({
  backend: createMemoryBackend({ exists: (_checkout, path) => known.has(path) }),
  checkout: '/checkout-one',
  other: '/checkout-two',
  cleanup: async () => {},
}))

describe('the in-memory backend holds no files', () => {
  it('its claim writes, decision records, supersessions and replays report no files', async () => {
    const backend = createMemoryBackend({ exists: () => true })
    const decision = (id: string, supersedes: string | null) => ({
      id, title: id, status: DecisionStatus.accepted, date: '2026-09-29', tags: [], supersedes, context: 'c', decision: 'd', consequences: 'q', considered: [],
    })
    const written = await backend.write('/c', KnowledgePatch.parse({ add: [{ text: 't', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }] }))
    const old = await backend.recordDecision('/c', decision('old', null))
    const superseding = await backend.recordDecision('/c', decision('new', 'old'))
    const replay = await backend.recordDecision('/c', decision('new', 'old'))
    expect([written, old, superseding, replay].map(r => r.files)).toEqual([[], [], [], []])
  })
})
