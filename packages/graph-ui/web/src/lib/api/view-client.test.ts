import { describe, expect, it } from 'bun:test'
import { QueryClient } from '@tanstack/query-core'
import { ScopeType } from '@orc/contracts/scope'
import { TOUCHABLE, VIEW } from '@orc/ui-core/wire'
import { type ApiError, setApiErrorHandler } from './client'
import { allViewsKey, fetchView, healthKey, touchKey, viewKey } from './view-client'

const isStale = (qc: QueryClient, k: readonly unknown[]): boolean | undefined => qc.getQueryState(k as unknown[])?.isInvalidated

// Pins whether TanStack's default partial-key matching invalidates a touch pattern against every
// held query whose params CONTAIN it, and no other. If this holds, touchKey can reuse viewKey's
// own shape with the touch's pattern params in place of a full param object — no predicate, no
// second matcher.
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

    // a scope pattern matches NESTED-partially: the chat it names goes stale, the other chat's
    // pane does not — which is what keeps every chat pane off every other chat's cadence
    await qc.invalidateQueries({ queryKey: touchKey('p', { name: VIEW.timeline, params: { scope: { type: ScopeType.chat, id: 'c1' } } }) })
    expect(isStale(qc, viewKey('p', VIEW.timeline, held))).toBe(true)
    expect(isStale(qc, viewKey('p', VIEW.timeline, { scope: { type: ScopeType.chat, id: 'c2' }, limit: 5 }))).toBe(false)
  })
})

// A seq regression/log reset (App.svelte's loadProject) resyncs the graph and ledger from a fresh
// snapshot but ships no touches — nothing else invalidates a view answered from before the reset,
// so the whole namespace has to drop in one call rather than one key per open pane.
describe('allViewsKey', () => {
  it('invalidates every held view AND touchable query, of any name/project/params', async () => {
    const qc = new QueryClient()
    qc.setQueryData(viewKey('p', VIEW.node, { id: 'a' }), 1)
    qc.setQueryData(viewKey('other-project', VIEW.plans, { taskId: 'x' }), 1)
    qc.setQueryData(healthKey('p'), 1)

    await qc.invalidateQueries({ queryKey: allViewsKey() })

    expect(isStale(qc, viewKey('p', VIEW.node, { id: 'a' }))).toBe(true)
    expect(isStale(qc, viewKey('other-project', VIEW.plans, { taskId: 'x' }))).toBe(true)
    expect(isStale(qc, viewKey('p', TOUCHABLE.health, {}))).toBe(true)
  })
})

describe('fetchView — a subject that no longer exists', () => {
  it('answers null for a node that is gone, and reports no error', async () => {
    const reported: ApiError[] = []
    const realFetch = globalThis.fetch
    setApiErrorHandler(err => reported.push(err))
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'node: not found' }), { status: 404 })) as typeof fetch
    try {
      const answer = await fetchView('p', VIEW.node, { id: 'note:project\u0000deleted-note' })
      expect(answer.data).toBeNull()
      expect(reported).toEqual([])
    } finally {
      globalThis.fetch = realFetch
      setApiErrorHandler(() => {})
    }
  })
})
