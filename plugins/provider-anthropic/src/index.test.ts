import { describe, expect, it } from 'bun:test'
import { costUSDFor, resolveModel } from '@orc/contracts'
import { createAnthropicProvider } from './index'

describe('anthropic provider', () => {
  it('exposes real per-MTok costs', () => {
    const p = createAnthropicProvider()
    expect(costUSDFor(p.costs, 'claude-sonnet-5', 1_000_000, 0)).toBe(3)
    expect(costUSDFor(p.costs, 'claude-opus-4-8', 0, 1_000_000)).toBe(25)
    expect(costUSDFor(p.costs, 'not-a-model', 1000, 1000)).toBeNull()
  })
  it('resolves through the registry helper and returns a LanguageModel handle', () => {
    const providers = new Map([['anthropic', createAnthropicProvider()]])
    const r = resolveModel(providers, 'anthropic/claude-sonnet-5')
    expect(r.modelId).toBe('claude-sonnet-5')
    expect(r.model).toBeDefined() // no network call — just the handle
  })
  it('config cost overrides win', () => {
    const p = createAnthropicProvider({ 'claude-sonnet-5': { inPerMTok: 1, outPerMTok: 2 } })
    expect(costUSDFor(p.costs, 'claude-sonnet-5', 1_000_000, 0)).toBe(1)
  })
})
