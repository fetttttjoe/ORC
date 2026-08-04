import type { LogRow } from '$lib/api/types'
import { STATE_CHANGE, EVENT_KIND } from '$lib/event-kinds'
import { qk } from '$lib/query-keys'

// Events that move the READ MODEL, and with it every corpus-level reading derived from it — the
// drift ratio, the pending backlog, the note counts. They ride the SSE stream already, so the
// reading refreshes when the corpus changes instead of on ConsoleHeader's 15s poll: a heal
// rewrites a note and clears its drift, and emitting only qk.node repainted the note while the
// ratio that write just improved stayed stale for up to a full interval.
//
// memory_accessed is deliberately ABSENT. A read moves `hits`, never currency, and preloads arrive
// at agent-loop cadence — refetching corpus health on each would put a whole-corpus git probe on
// exactly the cadence STATE_CHANGE exists to keep queries off.
const CORPUS_CHANGE: ReadonlySet<string> = new Set<string>([
  EVENT_KIND.memory_written,
  EVENT_KIND.memory_verified,
  EVENT_KIND.memory_deleted,
])

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
  if (CORPUS_CHANGE.has(row.kind)) out.push([...qk.health()])
  if (row.kind === EVENT_KIND.models_discovered) out.push(['models'])
  return out
}
