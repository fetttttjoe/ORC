import { describe, expect, it } from 'bun:test'
import { QueryClient } from '@tanstack/query-core'
import { ScopeType } from '@orc/contracts/scope'
import { VIEW } from '@orc/ui-core/wire'
import { type ApiError, setApiErrorHandler } from './client'
import { allViewsKey, fetchView, healthKey, touchKey, viewKey } from './view-client'

const isStale = (qc: QueryClient, k: readonly unknown[]): boolean | undefined => qc.getQueryState(k as unknown[])?.isInvalidated

describe('touchKey / viewKey — partial matching', () => {
  it('a touch pattern invalidates every held query whose params contain it, and no other', async () => {
    const qc = new QueryClient()
    qc.setQueryData(viewKey('p', VIEW.node, { id: 'a' }), 1)
    qc.setQueryData(viewKey('p', VIEW.node, { id: 'b' }), 1)
    const held = { scope: { type: ScopeType.chat, id: 'c1' }, limit: 5 }
    qc.setQueryData(viewKey('p', VIEW.timeline, held), 1)
    qc.setQueryData(viewKey('p', VIEW.timeline, { scope: { type: ScopeType.chat, id: 'c2' }, limit: 5 }), 1)

    // touched entries carry `{ name, params }` — `name` is a TouchableName (wire.ts's `Touch`).
    await qc.invalidateQueries({ queryKey: touchKey('p', { name: VIEW.node, params: { id: 'a' } }) })
    expect(isStale(qc, viewKey('p', VIEW.node, { id: 'a' }))).toBe(true)
    expect(isStale(qc, viewKey('p', VIEW.node, { id: 'b' }))).toBe(false)

    await qc.invalidateQueries({ queryKey: touchKey('p', { name: VIEW.timeline, params: { scope: { type: ScopeType.chat, id: 'c1' } } }) })
    expect(isStale(qc, viewKey('p', VIEW.timeline, held))).toBe(true)
    expect(isStale(qc, viewKey('p', VIEW.timeline, { scope: { type: ScopeType.chat, id: 'c2' }, limit: 5 }))).toBe(false)
  })
})

describe('allViewsKey', () => {
  it('invalidates every held view AND touchable query, of any name/project/params', async () => {
    const qc = new QueryClient()
    qc.setQueryData(viewKey('p', VIEW.node, { id: 'a' }), 1)
    qc.setQueryData(viewKey('other-project', VIEW.plans, { taskId: 'x' }), 1)
    qc.setQueryData(healthKey('p'), 1)

    await qc.invalidateQueries({ queryKey: allViewsKey() })

    expect(isStale(qc, viewKey('p', VIEW.node, { id: 'a' }))).toBe(true)
    expect(isStale(qc, viewKey('other-project', VIEW.plans, { taskId: 'x' }))).toBe(true)
    expect(isStale(qc, healthKey('p'))).toBe(true)
  })
})

describe('fetchView — a subject that no longer exists', () => {
  it('answers null for a node that is gone, and reports no error', async () => {
    const reported: ApiError[] = []
    const realFetch = globalThis.fetch
    const previousHandler = setApiErrorHandler(err => reported.push(err))
    const notFound: typeof fetch = Object.assign(
      async (): Promise<Response> => new Response(JSON.stringify({ error: 'node: not found' }), { status: 404 }),
      { preconnect: () => {} },
    )
    globalThis.fetch = notFound
    try {
      const answer = await fetchView('p', VIEW.node, { id: 'artifact:t1:deleted.txt' })
      expect(answer.data).toBeNull()
      expect(reported).toEqual([])
    } finally {
      globalThis.fetch = realFetch
      setApiErrorHandler(previousHandler)
    }
  })
})

describe('setApiErrorHandler', () => {
  it('hands back the handler it replaced, so a caller can restore exactly that', () => {
    const first = (): void => {}
    const second = (): void => {}
    const original = setApiErrorHandler(first)
    try {
      expect(setApiErrorHandler(second)).toBe(first)
    } finally {
      setApiErrorHandler(original)
    }
  })
})
