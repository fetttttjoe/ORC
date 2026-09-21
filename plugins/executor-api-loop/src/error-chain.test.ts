import { describe, expect, it } from 'bun:test'
import { MAX_CAUSE_DEPTH, errField, errorChainNodes } from './error-chain'

const nodesOf = (err: unknown, maxDepth?: number): unknown[] => [...errorChainNodes(err, maxDepth)]

describe('errField', () => {
  it('reads a key off an object', () => {
    expect(errField({ statusCode: 429 }, 'statusCode')).toBe(429)
  })

  it('returns undefined for non-objects and missing keys', () => {
    expect(errField(null, 'code')).toBeUndefined()
    expect(errField(undefined, 'code')).toBeUndefined()
    expect(errField('a string', 'code')).toBeUndefined()
    expect(errField(42, 'code')).toBeUndefined()
    expect(errField({}, 'code')).toBeUndefined()
  })
})

describe('errorChainNodes', () => {
  it('yields just the root when it has no lastError or cause', () => {
    const err = new Error('plain')
    expect(nodesOf(err)).toEqual([err])
  })

  it('walks cause in order', () => {
    const c = { code: 'ECONNRESET' }
    const b = { cause: c }
    const a = { cause: b }
    expect(nodesOf(a)).toEqual([a, b, c])
  })

  it('prefers lastError over cause at the same node', () => {
    const viaCause = { statusCode: 400 }
    const viaLastError = { statusCode: 503 }
    const root = { lastError: viaLastError, cause: viaCause }
    expect(nodesOf(root)).toEqual([root, viaLastError])
  })

  it('falls back to cause when lastError self-references', () => {
    const tail = { statusCode: 429 }
    const root: Record<string, unknown> = { cause: tail }
    root.lastError = root
    expect(nodesOf(root)).toEqual([root, tail])
  })

  it('stops at a direct cause self-reference instead of looping', () => {
    const selfref: Record<string, unknown> = { name: 'Weird' }
    selfref.cause = selfref
    expect(nodesOf(selfref)).toEqual([selfref])
  })

  it('terminates a two-node cycle after visiting each node once', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { cause: a }
    a.cause = b
    expect(nodesOf(a)).toEqual([a, b])
  })

  it('caps a legitimately deep chain at MAX_CAUSE_DEPTH nodes', () => {
    let deep: Record<string, unknown> = { code: 'ECONNRESET' }
    for (let i = 0; i < 12; i += 1) deep = { cause: deep }
    expect(nodesOf(deep)).toHaveLength(MAX_CAUSE_DEPTH)
  })

  it('honours a caller-supplied maxDepth', () => {
    const c = { code: 'ECONNRESET' }
    const b = { cause: c }
    const a = { cause: b }
    expect(nodesOf(a, 2)).toEqual([a, b])
  })

  it('yields a lone non-object node without throwing', () => {
    expect(nodesOf('a string')).toEqual(['a string'])
    expect(nodesOf(42)).toEqual([42])
  })

  it('yields nothing for null or undefined', () => {
    expect(nodesOf(null)).toEqual([])
    expect(nodesOf(undefined)).toEqual([])
  })
})
