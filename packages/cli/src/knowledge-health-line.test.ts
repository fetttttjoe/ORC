import { describe, expect, it } from 'bun:test'
import { KnowledgeHealthState } from '@orc/contracts'
import { knowledgeHealthLine } from './knowledge-health-line'

describe('knowledgeHealthLine', () => {
  it('prints the claim and suspect counts when ok', () => {
    expect(knowledgeHealthLine({ state: KnowledgeHealthState.ok, claims: 122, suspect: 3 })).toBe('knowledge: 122 claims · 3 suspect')
  })
  it('prints the reason when unavailable', () => {
    expect(knowledgeHealthLine({ state: KnowledgeHealthState.unavailable, reason: 'no checkout' })).toBe('knowledge unavailable: no checkout')
  })
})
