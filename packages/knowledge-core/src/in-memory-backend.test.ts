import { describe, expect, it } from 'bun:test'
import { ClaimClass, DecisionStatus, KnowledgePatch } from '@orc/contracts'
import { createTreeSitterStructure } from '@orc/structure-treesitter'
import { describeKnowledgeBackend, contractSourceOf, CONTRACT_DIRS, CONTRACT_FILES } from './contract-suite'
import { createInMemoryBackend, NO_STRUCTURE } from './in-memory-backend'

const known = new Set<string>([...CONTRACT_FILES, ...CONTRACT_DIRS])
describeKnowledgeBackend('the in-memory backend', async () => {
  const rewritten = new Map<string, string>()
  const keyOf = (checkout: string, file: string): string => `${checkout}\0${file}`
  return {
    backend: createInMemoryBackend({
      exists: (_checkout, path) => known.has(path),
      structure: createTreeSitterStructure(),
      read: (checkout, path) => rewritten.get(keyOf(checkout, path)) ?? (CONTRACT_FILES.some(file => file === path) ? contractSourceOf(path) : null),
    }),
    checkout: '/checkout-one',
    other: '/checkout-two',
    rewrite: (checkout, file, source) => { rewritten.set(keyOf(checkout, file), source) },
    commit: () => {},
    cleanup: async () => {},
  }
})

describe('the in-memory backend holds no files', () => {
  it('its claim writes, decision records, supersessions and replays report no files', async () => {
    const backend = createInMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
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
