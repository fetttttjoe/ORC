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
    // A task is addressed by TWO key families: `task` (plans, transcript, log) and `node` (the
    // graph row the inspector and the run monitor read). Emitting only the first left a live run's
    // step statuses, iteration count and spend frozen at mount — nothing threw, the numbers just
    // stopped moving. Both spellings mean the same task, so both refetch together.
    const touch = (id: string): void => void out.push([...qk.task(id)], [...qk.node(id)])
    touch(row.taskId)
    // the parent's rendered plan carries its children's step states, so a child's change
    // invalidates the parent too — parentage comes from the graph's child edge, not the id string
    const parent = parentOf(row.taskId)
    if (parent) touch(parent)
  }
  if (row.noteRef) out.push([...qk.node(row.noteRef)])
  if (row.kind === EVENT_KIND.models_discovered) out.push(['models'])
  return out
}
