import type { LogRow } from '$lib/api/types'
import { STATE_CHANGE, EVENT_KIND } from '$lib/event-kinds'
import { qk } from '$lib/query-keys'

/** query-key prefixes to invalidate for one row; [] for working noise */
export function invalidations(
  row: Pick<LogRow, 'kind' | 'taskId' | 'noteRef'>,
  parentOf: (taskId: string) => string | null,
): readonly string[][] {
  if (!STATE_CHANGE.has(row.kind)) return []
  const out: string[][] = []
  if (row.taskId) {
    out.push([...qk.task(row.taskId)])
    // the parent's rendered plan carries its children's step states, so a child's change
    // invalidates the parent too — parentage comes from the graph's child edge, not the id string
    const parent = parentOf(row.taskId)
    if (parent) out.push([...qk.task(parent)])
  }
  if (row.noteRef) out.push([...qk.node(row.noteRef)])
  if (row.kind === EVENT_KIND.models_discovered) out.push(['models'])
  return out
}
