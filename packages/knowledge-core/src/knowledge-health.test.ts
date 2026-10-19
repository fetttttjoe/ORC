import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, ClaimClass, ClaimState, Door, KnowledgeHealthState, NO_CHAT, type ClaimDrift, type KnowledgeAccess, type MemoryAuthor } from '@orc/contracts'
import { createMemoryBackend, NO_STRUCTURE } from './memory-backend'
import { knowledgeHealth } from './knowledge-health'
import { createKnowledgePort } from './port'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.cli, workspaceId: 'ws-1', origin: NO_CHAT(Door.cli) }
const portOver = () => createKnowledgePort({
  backend: createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null }),
  checkoutOf: async () => '/checkout',
  append: async () => {},
  warn: () => {},
})

describe('knowledgeHealth', () => {
  it('carries the reason of an unavailable access', async () => {
    expect(await knowledgeHealth({ unavailable: 'x' }, author)).toEqual({ state: KnowledgeHealthState.unavailable, reason: 'x' })
  })
  it('counts the claims of a port, none suspect', async () => {
    const port = portOver()
    const call = { author, idempotencyKey: null }
    await port.write(call, { add: [{ text: 'a', class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] }, { text: 'b', class: ClaimClass.fact, anchors: [{ path: 'src/b.ts' }] }] })
    expect(await knowledgeHealth({ port }, author)).toEqual({ state: KnowledgeHealthState.ok, claims: 2, suspect: 0 })
  })
  it('counts suspect claims apart from clean ones', async () => {
    const claim = { text: 't', class: ClaimClass.fact, anchors: [], tags: [], sources: [], decision: null, location: 'knowledge/a.md' }
    const drift = (id: string, state: ClaimState): ClaimDrift => ({ claim: { ...claim, id }, state, basis: null, anchors: [] })
    const access: KnowledgeAccess = { port: { ...portOver(), drift: async () => [drift('a', ClaimState.suspect), drift('b', ClaimState.suspect), drift('c', ClaimState.clean)] } }
    expect(await knowledgeHealth(access, author)).toEqual({ state: KnowledgeHealthState.ok, claims: 3, suspect: 2 })
  })
  it('reports unavailable with the message when drift throws', async () => {
    const access: KnowledgeAccess = { port: { ...portOver(), drift: async () => { throw new Error('boom') } } }
    expect(await knowledgeHealth(access, author)).toEqual({ state: KnowledgeHealthState.unavailable, reason: 'boom' })
  })
})
