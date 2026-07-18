import { describe, expect, it } from 'bun:test'
import { PAYLOAD_SCHEMAS } from './events'
import { OperationSpec } from './operations'

describe('operations', () => {
  it('parses a spec and rejects an empty name', () => {
    expect(OperationSpec.safeParse({ operationId: 'r1:model:1', kind: 'model', name: 'fake/m', before: {} }).success).toBe(true)
    expect(OperationSpec.safeParse({ operationId: 'r1:model:1', kind: 'model', name: '', before: {} }).success).toBe(false)
  })

  it('parses each transition payload', () => {
    expect(PAYLOAD_SCHEMAS.operation_started.safeParse({
      operationId: 'r1:tool:1:c1', attempt: 1, operationKind: 'tool', name: 'echo', before: { text: 'hi' },
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.operation_completed.safeParse({
      operationId: 'r1:tool:1:c1', attempt: 1, after: { ok: true },
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.operation_failed.safeParse({
      operationId: 'r1:tool:1:c1', attempt: 2, error: { message: 'boom' },
    }).success).toBe(true)
  })

  it('rejects attempt 0 on every transition', () => {
    expect(PAYLOAD_SCHEMAS.operation_started.safeParse({
      operationId: 'x', attempt: 0, operationKind: 'model', name: 'm', before: null,
    }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.operation_completed.safeParse({ operationId: 'x', attempt: 0, after: null }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.operation_failed.safeParse({ operationId: 'x', attempt: 0, error: null }).success).toBe(false)
  })
})
