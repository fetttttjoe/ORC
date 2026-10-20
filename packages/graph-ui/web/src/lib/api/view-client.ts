// The one read path for the view registry; free of Svelte runes so bun test can import it
import { z } from 'zod'
import {
  ViewEnvelope, ViewName, VIEW, viewPath, WIRE, type Touch, type TouchableName,
} from '@orc/ui-core/wire'
import type { QueryClient } from '@tanstack/svelte-query'
import { ApiError, reportApiError } from './client'
import { describeZodError } from './parse'
import { newer } from './seq-guard'
import { makeCoalescer } from './touch-coalesce'

// re-derived from WIRE: ui-core's views/view.ts pulls server-only dependencies into the browser
export type ViewParams<N extends ViewName> = z.infer<(typeof WIRE)[N]['params']>
export type ViewResult<N extends ViewName> = z.infer<(typeof WIRE)[N]['result']>

/** one view's cache entry — what fetchView resolves and what the seq guard compares */
export type ViewEnvelopeData<N extends ViewName> = { seq: number; data: ViewResult<N> | null }

// A homomorphic mapped type is the one indexed-access shape the compiler simplifies for generic N
type ResultSchemas<N extends ViewName> = { [K in N]: z.ZodType<ViewResult<K>> }
const RESULT_SCHEMAS: ResultSchemas<ViewName> = {
  [VIEW.timeline]: WIRE.timeline.result,
  [VIEW.chats]: WIRE.chats.result,
  [VIEW.node]: WIRE.node.result,
  [VIEW.transcript]: WIRE.transcript.result,
  [VIEW.plans]: WIRE.plans.result,
  [VIEW.planNotes]: WIRE.planNotes.result,
  [VIEW.models]: WIRE.models.result,
  [VIEW.operatorState]: WIRE.operatorState.result,
}

// the one prefix every view query key hangs off; only viewKey and allViewsKey spell it
const VIEW_KEY_ROOT = 'view' as const

// ['view', name, project, params]; HEALTH_KEY_NAME lets the health poll share the builder
export function viewKey<N extends TouchableName | typeof HEALTH_KEY_NAME>(project: string, name: N, params: Record<string, unknown>): readonly [typeof VIEW_KEY_ROOT, N, string, Record<string, unknown>] {
  return [VIEW_KEY_ROOT, name, project, params] as const
}

// Every view query: a resync ships no touched entries, so this root key drops them all
export const allViewsKey = (): readonly [typeof VIEW_KEY_ROOT] => [VIEW_KEY_ROOT] as const

type HealthKeyName = 'health' extends TouchableName ? never : 'health'
const HEALTH_KEY_NAME: HealthKeyName = 'health'

// The shared cache identity of the `/api/health` poll, which the header and banner both read
export const healthKey = (project: string): ReturnType<typeof viewKey<typeof HEALTH_KEY_NAME>> => viewKey(project, HEALTH_KEY_NAME, {})

// t.params is a PATTERN: TanStack's partial key match invalidates queries whose params contain it
export function touchKey(project: string, t: Touch): readonly ['view', TouchableName, string, Record<string, unknown>] {
  return viewKey(project, t.name, t.params)
}

// a missing subject is a state the pane renders, not an error: no plan yet, a removed node
const NULL_ON_404: ReadonlySet<ViewName> = new Set([VIEW.plans, VIEW.node])

// Parsed in two passes: a fresh z.object around the abstract per-view schema breaks the data type
export async function fetchView<N extends ViewName>(project: string, name: N, params: ViewParams<N>): Promise<ViewEnvelopeData<N>> {
  const res = await fetch(viewPath(name, project, params))
  if (res.status === 404 && NULL_ON_404.has(name)) return { seq: 0, data: null }
  if (!res.ok) {
    const err = new ApiError(name, await res.text().catch(() => res.statusText))
    reportApiError(err)
    throw err
  }
  const envelope = ViewEnvelope(z.unknown()).safeParse(await res.json())
  if (!envelope.success) {
    const err = new ApiError(name, `response did not match the expected shape — ${describeZodError(envelope.error)}`)
    reportApiError(err)
    throw err
  }
  const data = RESULT_SCHEMAS[name].safeParse(envelope.data.data)
  if (!data.success) {
    const err = new ApiError(name, `response did not match the expected shape — ${describeZodError(data.error)}`)
    reportApiError(err)
    throw err
  }
  return { seq: envelope.data.seq, data: data.data }
}

/** newer() against what this key already holds: the race fetchView alone cannot guard */
export async function fetchViewGuarded<N extends ViewName>(queryClient: QueryClient, project: string, name: N, params: ViewParams<N>): Promise<ViewEnvelopeData<N>> {
  const key = viewKey(project, name, params)
  const fetched = await fetchView(project, name, params)
  return newer(queryClient.getQueryData<ViewEnvelopeData<N>>(key), fetched)
}

// 250ms [conjecture: tune against a live run]; module-level so panes share one timer
const TOUCH_COALESCE_MS = 250
const coalescer = makeCoalescer({ setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: id => window.clearTimeout(id) }, TOUCH_COALESCE_MS)

/** sse.ts calls this once per `touched` entry; the coalescer folds a burst into one refetch */
export function invalidateTouch(queryClient: QueryClient, project: string, t: Touch): void {
  const key = touchKey(project, t)
  coalescer.schedule(JSON.stringify(key), () => void queryClient.invalidateQueries({ queryKey: key }))
}
