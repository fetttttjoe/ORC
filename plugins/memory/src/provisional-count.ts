import type { MemoryStore } from '@orc/contracts'
import { provisionalOf, type WorkspaceViewProbe } from './provisional'

/**
 * How many notes are STILL PROVISIONAL in each workspace — the one number a workspace-health
 * reader needs from the corpus: knowledge written in a checkout that has not landed is knowledge
 * that disappears with the checkout.
 *
 * A composition, not a query: the store has no workspace filter (MemoryFilter is scope/category/
 * tag/tier/kind) and does not need one — the corpus is ~100 notes, the whole listing is one read,
 * and the flag is a DERIVATION that cannot be pushed into SurrealQL anyway, because it depends on
 * the workspace table's current standing rather than on anything stored on the row.
 *
 * `workspaceView` is the probe, not a snapshot, for the reason every other consumer takes it that
 * way: an `orc ws merge` recorded mid-session must clear the count on the very next read.
 *
 * The result is SPARSE: a workspace absent from the map has nothing pending, which is a MEASURED
 * zero — the whole map is, including an empty one. "Never asked" is not in this map's vocabulary at
 * all; a caller that could not reach the store reports `null` in place of the map, and that split is
 * what keeps a Surreal outage from relabelling every abandoned checkout `idle`.
 */
export async function provisionalNoteCounts(
  store: Pick<MemoryStore, 'list'>,
  workspaceView: WorkspaceViewProbe,
): Promise<Map<string, number>> {
  const { workspaces, merged } = await workspaceView()
  const counts = new Map<string, number>()
  for (const n of await store.list()) {
    if (provisionalOf(n, workspaces, merged) === null) continue
    counts.set(n.workspaceId, (counts.get(n.workspaceId) ?? 0) + 1)
  }
  return counts
}
