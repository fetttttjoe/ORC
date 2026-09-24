import { describe, expect, it } from 'bun:test'
import type { KnowledgePlugin } from '@orc/contracts'
import { createMemoryBackend } from './memory-backend'
import { REGISTRY_REFUSAL, resolveKnowledgeBackend } from './registry'

const seen: Array<Record<string, unknown>> = []
const plugin: KnowledgePlugin = { id: 'mem', create: options => { seen.push(options); return createMemoryBackend({ exists: () => true }) } }

describe('resolveKnowledgeBackend', () => {
  it('null config means knowledge is off', () => {
    expect(resolveKnowledgeBackend(null, [plugin])).toBeNull()
  })
  it('creates the named plugin with its options', () => {
    expect(resolveKnowledgeBackend({ plugin: 'mem', options: { a: 1 } }, [plugin])).not.toBeNull()
    expect(seen.at(-1)).toEqual({ a: 1 })
  })
  it('refuses an unknown plugin, listing the known ones', () => {
    expect(() => resolveKnowledgeBackend({ plugin: 'nope', options: {} }, [plugin])).toThrow(REGISTRY_REFUSAL.unknownPlugin('nope', ['mem']))
  })
})
