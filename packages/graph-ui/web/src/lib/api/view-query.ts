// view-client.ts's read path, bound to Svelte's reactive query system and the app's one global
// project selection. Split from view-client.ts so that module stays free of the runed session
// store — see its top comment — while every pane still gets a one-line `createQuery(viewQuery(...))`.
import { keepPreviousData, useQueryClient } from '@tanstack/svelte-query'
import type { ViewName } from '@orc/ui-core/wire'
import { fetchViewGuarded, viewKey, type ViewEnvelopeData, type ViewParams, type ViewResult } from './view-client'
import { session } from '$lib/stores/session.svelte'

/**
 * `createQuery` options for one view, reactive over `params()` and the active project
 * (`session.sel.project` — the one global selection every pane already reads off this store).
 * `params() === null` disables the query: a pane with no subject yet (no task selected) asks for
 * nothing rather than fetching with a placeholder id that would 400.
 *
 * `select` unwraps the envelope so a component reads `query.data` directly as `ViewResult<N>`
 * rather than a nested `query.data.data`. `seq` stays available to `newer()` inside `queryFn`
 * (fetchViewGuarded) because `queryClient.getQueryData` reads the RAW cached entry (pre-select);
 * `select` only reshapes what the component sees, never what is stored.
 */
export function viewQuery<N extends ViewName>(name: N, params: () => ViewParams<N> | null) {
  const queryClient = useQueryClient()
  return () => {
    const p = params()
    const project = session.sel.project
    return {
      queryKey: viewKey(project, name, p ?? {}),
      queryFn: () => {
        // `enabled` below is false whenever params() returns null, so TanStack never RUNS this —
        // narrowed with a throw, not a cast, for the one case that would prove that wrong.
        if (p === null) throw new Error(`viewQuery(${name}): queryFn ran with no params — enabled should have suppressed this`)
        return fetchViewGuarded(queryClient, project, name, p)
      },
      enabled: p !== null && project !== '',
      placeholderData: keepPreviousData,
      select: (envelope: ViewEnvelopeData<N>): ViewResult<N> | null => envelope.data,
    }
  }
}
