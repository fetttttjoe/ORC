import { describe, expect, it } from 'bun:test'
import { ApprovalPolicy, evaluateApproval } from './approval'

describe('evaluateApproval', () => {
  const policy = ApprovalPolicy.parse({
    rules: [
      { maxDepth: 2, maxCostUSD: 1, then: 'auto' },
      { type: 'research', then: 'auto' },
    ],
  })
  it('first matching rule wins; every present field must match', () => {
    expect(evaluateApproval(policy, { depth: 1, costEstimateUSD: 0.5, type: 'generic' })).toEqual({ then: 'auto', ruleIndex: 0 })
    expect(evaluateApproval(policy, { depth: 3, costEstimateUSD: 0.5, type: 'generic' })).toEqual({ then: 'manual' }) // depth fails rule 0, type fails rule 1 → default
    expect(evaluateApproval(policy, { depth: 3, costEstimateUSD: null, type: 'research' })).toEqual({ then: 'auto', ruleIndex: 1 })
  })
  it('null costEstimateUSD never matches a maxCostUSD rule', () => {
    expect(evaluateApproval(policy, { depth: 1, costEstimateUSD: null, type: 'generic' })).toEqual({ then: 'manual' })
  })
  it('defaults: manual, empty rules', () => {
    const p = ApprovalPolicy.parse({})
    expect(p.default).toBe('manual')
    expect(evaluateApproval(p, { depth: 0, costEstimateUSD: 0, type: 'generic' })).toEqual({ then: 'manual' })
  })
})
