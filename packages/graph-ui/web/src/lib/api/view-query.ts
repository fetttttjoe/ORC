// view-client's read path bound to Svelte's reactive query and the one project selection
import { keepPreviousData, useQueryClient } from '@tanstack/svelte-query'
import type { ViewName } from '@orc/ui-core/wire'
import { fetchViewGuarded, viewKey, type ViewEnvelopeData, type ViewParams, type ViewResult } from './view-client'
import { session } from '$lib/stores/session.svelte'

// params() === null disables the query; select unwraps the envelope, seq stays in the cache
export function viewQuery<N extends ViewName>(name: N, params: () => ViewParams<N> | null) {
  const queryClient = useQueryClient()
  return () => {
    const p = params()
    const project = session.sel.project
    return {
      queryKey: viewKey(project, name, p ?? {}),
      queryFn: () => {
        // enabled is false when params() is null, so this never runs: throw, not cast
        if (p === null) throw new Error(`viewQuery(${name}): queryFn ran with no params — enabled should have suppressed this`)
        return fetchViewGuarded(queryClient, project, name, p)
      },
      enabled: p !== null && project !== '',
      placeholderData: keepPreviousData,
      select: (envelope: ViewEnvelopeData<N>): ViewResult<N> | null => envelope.data,
    }
  }
}
