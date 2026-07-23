import type { Graph, GraphPatch } from '@orc/ui-core'

// The browser-side adapter seam: page logic talks to this interface only. SigmaRenderer is
// implementation #1; a CosmosRenderer (GPU, 100k+ nodes) can replace it without touching app.ts.
export interface GraphRenderer {
  setGraph(g: Graph): void // full snapshot (initial load / project switch)
  applyPatch(p: GraphPatch): void // incremental — must not recompute the world
  select(nodeId: string | null): void // highlight the navigated node (idempotent)
  flash(nodeIds: string[]): void // transient activity ripple — unknown ids are ignored
  focus(nodeIds: Set<string> | null): void // dim everything outside the set; null restores
  onNodeClick(cb: (nodeId: string) => void): void
  destroy(): void
}
