// The ONE read path for the view registry: every pane asks for a named view through here, cached
// by TanStack and invalidated by whatever the stream frame says it touched. Nothing else in this
// app builds a `/api/view/*` URL, parses a view's response, or keys its cache entry by hand — a
// second copy of any of those three could drift from what the registry actually answers or
// invalidates, and drift here shows up as a pane that silently stops refreshing.
//
// Deliberately free of any Svelte-rune import (session.svelte.ts, a `.svelte` component): runes
// compile only inside Svelte-processed files, and this module's key-building and fetch logic is
// exercised by view-client.test.ts under plain `bun test`, which has no Svelte compiler in the
// loop — importing a runed store here would throw `$state is not defined` the moment the test
// file's import runs, before a single assertion executes. The reactive query factory that DOES
// need the session store and `useQueryClient()` lives in view-query.ts, its neighbour.
import { z } from 'zod'
import {
  TOUCHABLE, ViewEnvelope, ViewName, VIEW, viewPath, WIRE, type Touch, type TouchableName,
} from '@orc/ui-core/wire'
import type { QueryClient } from '@tanstack/svelte-query'
import { ApiError, reportApiError } from './client'
import { describeZodError } from './parse'
import { newer } from './seq-guard'
import { makeCoalescer } from './touch-coalesce'

// The wire's own param/result types, re-derived from WIRE rather than imported from ui-core's
// views/view.ts: that module is reached only through the bare `@orc/ui-core` entry point, which
// pulls in the projection's server-only dependencies (kernel, ai) — the same reason graph-wire.ts
// takes no imports. WIRE itself lives in the browser-safe `/wire` subpath, so deriving the same
// one-line formula from it here keeps this a single source (WIRE) rather than a second rule.
export type ViewParams<N extends ViewName> = z.infer<(typeof WIRE)[N]['params']>
export type ViewResult<N extends ViewName> = z.infer<(typeof WIRE)[N]['result']>

/** one view's cache entry — what fetchView resolves and what the seq guard compares */
export type ViewEnvelopeData<N extends ViewName> = { seq: number; data: ViewResult<N> | null }

/**
 * `WIRE[name].result` for a GENERIC `name: N` does not simplify to `z.ZodType<ViewResult<N>>` —
 * indexing a plain (non-mapped) object type by a generic key distributes across every member of
 * its constraint instead, so `fetchView`'s parse produced the union of all seven views' results
 * and failed to assign to its own declared return type. ui-core's registry.ts hit the identical
 * problem for params (see its `ParamSchemas` comment) and fixed it the same way: a HOMOMORPHIC
 * mapped type (`{[K in N]: ...}`, N unmodified) IS the one indexed-access shape the compiler
 * simplifies correctly, and a wider instantiation (`ResultSchemas<ViewName>`, all seven keys) is
 * assignable to a narrower one (`ResultSchemas<N>`) by that same mapped-type rule — so one constant
 * built at the full `ViewName` width serves every call regardless of which `N` it is indexed by.
 */
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

/** the ONE prefix every view/touchable query key hangs off — `viewKey`, `allViewsKey` and nothing
 * else may spell it, so a resync can drop every held view with no second copy of the literal. */
const VIEW_KEY_ROOT = 'view' as const

/**
 * A held query's key: `['view', name, project, params]`. `name` is widened to `TouchableName`
 * (not just `ViewName`) so `health` — a Touchable, never a view — keys through the SAME builder a
 * `touched` entry names it by; see `healthKey` below.
 */
export function viewKey<N extends TouchableName>(project: string, name: N, params: Record<string, unknown>): readonly [typeof VIEW_KEY_ROOT, N, string, Record<string, unknown>] {
  return [VIEW_KEY_ROOT, name, project, params] as const
}

/**
 * Every view/touchable query, of any name/project/params — the whole namespace `viewKey` builds
 * under. A seq regression or log reset (App.svelte's `loadProject`) resyncs the graph and ledger
 * from a fresh snapshot but ships no compensating `touched` entries (server.ts's reset path sends
 * `touched: []`), so nothing else invalidates a view answered from before the reset. TanStack's
 * partial-key match invalidates every key that CONTAINS this one, which is every `viewKey`/
 * `healthKey` entry — see `allViewsKey`'s own test.
 */
export const allViewsKey = (): readonly [typeof VIEW_KEY_ROOT] => [VIEW_KEY_ROOT] as const

// The shared cache identity for the plain `/api/health` route. `project` here names the STREAMED
// connection the `health` touch arrives on (server.ts emits it per-connection), not necessarily
// what the answer is about: `opts.health()` probes this server's own memory/supervisor state,
// unscoped by project (server.ts's `/api/health` handler sends no `project` param). Keying by
// project is what makes the touch match, so every project switch pays one refetch of an otherwise
// byte-identical answer — a defensible trade, not a bug, and not free.
export const healthKey = (project: string): ReturnType<typeof viewKey<typeof TOUCHABLE.health>> => viewKey(project, TOUCHABLE.health, {})

/**
 * The key a `touched` entry invalidates by. `t.params` is a PATTERN, not necessarily a whole param
 * set — TanStack's `invalidateQueries` matches keys by partial structural equality
 * (`partialMatchKey` in `@tanstack/query-core`, walked off the PATTERN's own keys), so a query held
 * under params that CONTAIN the pattern's keys with equal values is invalidated, and one that
 * doesn't is left alone. Pinned by view-client.test.ts against a real QueryClient: partial matching
 * held, so this needs no predicate-based fallback matcher.
 */
export function touchKey(project: string, t: Touch): readonly ['view', TouchableName, string, Record<string, unknown>] {
  return viewKey(project, t.name, t.params)
}

// a missing subject is a state the pane renders, not an error: no plan yet, a deleted note
const NULL_ON_404: ReadonlySet<ViewName> = new Set([VIEW.plans, VIEW.node])

/**
 * One view read, parsed against the SAME schema the registry answers with (`WIRE[name].result`,
 * inside the envelope that carries `seq`). Exported standalone (not only through `viewQuery` in
 * view-query.ts) for the imperative reads App.svelte's boot and Ledger's paging need — a cached,
 * reactive query is the wrong shape for "fetch this page once, right now."
 *
 * Parsed in TWO passes rather than one `ViewEnvelope(RESULT_SCHEMAS[name]).safeParse(...)`: zod's
 * object-shape inference needs the schema's CONCRETE subtype to decide whether a key is required,
 * and `RESULT_SCHEMAS[name]`'s static type is the abstract `z.ZodType<ViewResult<N>>` (that
 * abstraction is what let the mapped-type trick above resolve `N` instead of unioning all seven
 * views) — so wrapping it in a fresh `z.object` produced a shape neither required nor optional in
 * `data` and failed to assign to `ViewEnvelopeData<N>`. `ViewEnvelope(z.unknown())` sidesteps it:
 * `z.unknown()` is concrete, so the ENVELOPE parses cleanly, and `.safeParse` on the abstract
 * per-view schema needs no subtype introspection — only its type parameter, which `N` supplies.
 */
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

/** newer() applied against whatever this key already holds — the race fetchView alone cannot guard against */
export async function fetchViewGuarded<N extends ViewName>(queryClient: QueryClient, project: string, name: N, params: ViewParams<N>): Promise<ViewEnvelopeData<N>> {
  const key = viewKey(project, name, params)
  const fetched = await fetchView(project, name, params)
  return newer(queryClient.getQueryData<ViewEnvelopeData<N>>(key), fetched)
}

// The trailing-250ms coalescer for touch-driven invalidation — see touch-coalesce.ts. Module-level
// because the touches of every open pane share it: two panes touched by the same event must
// collapse to the SAME trailing invalidation, not one timer each.
//
// 250ms [conjecture: tune against a live run] — long enough to fold a running step's agent-loop
// burst on the transcript view (several touches/sec) into one refetch, short enough that a real
// change still reads as live.
const TOUCH_COALESCE_MS = 250
const coalescer = makeCoalescer({ setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: id => window.clearTimeout(id) }, TOUCH_COALESCE_MS)

/** sse.ts calls this once per `touched` entry on a frame — the coalescer folds a burst into one refetch */
export function invalidateTouch(queryClient: QueryClient, project: string, t: Touch): void {
  const key = touchKey(project, t)
  coalescer.schedule(JSON.stringify(key), () => void queryClient.invalidateQueries({ queryKey: key }))
}
