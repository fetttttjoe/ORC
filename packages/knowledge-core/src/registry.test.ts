import { describe, expect, it } from 'bun:test'
import type { KnowledgeHost, KnowledgePlugin } from '@orc/contracts'
import { createInMemoryBackend, NO_STRUCTURE } from './in-memory-backend'
import { REGISTRY_REFUSAL, resolveKnowledgeBackend } from './registry'

const seen: Array<{ options: Record<string, unknown>; host: KnowledgeHost }> = []
const host: KnowledgeHost = { structure: NO_STRUCTURE }
const plugin: KnowledgePlugin = {
  id: 'mem',
  create: (options, given) => { seen.push({ options, host: given }); return createInMemoryBackend({ exists: () => true, structure: given.structure, read: () => null }) },
}

describe('resolveKnowledgeBackend', () => {
  it('null config means knowledge is off', () => {
    expect(resolveKnowledgeBackend(null, [plugin], host)).toBeNull()
  })
  it('creates the named plugin with its options and the host', () => {
    expect(resolveKnowledgeBackend({ plugin: 'mem', options: { a: 1 } }, [plugin], host)).not.toBeNull()
    expect(seen.at(-1)).toEqual({ options: { a: 1 }, host })
  })
  it('refuses an unknown plugin, listing the known ones', () => {
    expect(() => resolveKnowledgeBackend({ plugin: 'nope', options: {} }, [plugin], host)).toThrow(REGISTRY_REFUSAL.unknownPlugin('nope', ['mem']))
  })
})
