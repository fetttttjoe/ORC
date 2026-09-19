import { describe, expect, it } from 'bun:test'
import { ScopeType } from './scope'
import { Scope } from './scope'

describe('Scope', () => {
  it('rejects a task scope that does not say whether it covers the subtree', () => {
    expect(Scope.safeParse({ type: ScopeType.task, id: 't1' }).success).toBe(false)
  })
})
