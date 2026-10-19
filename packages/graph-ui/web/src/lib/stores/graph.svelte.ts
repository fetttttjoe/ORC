// the one copy of graph state; the SSE layer is its only writer
import { SvelteMap } from 'svelte/reactivity'
import { EDGE, linkKey } from '@orc/ui-core/graph-wire'
import type { GraphLink, GraphNode, GraphPatch, GraphSnapshot } from '$lib/api/types'

class GraphStore {
  readonly nodes = new SvelteMap<string, GraphNode>()
  readonly links = new SvelteMap<string, GraphLink>()
  seq = $state(0)

  setSnapshot(s: GraphSnapshot): void {
    this.nodes.clear()
    this.links.clear()
    for (const n of s.nodes) this.nodes.set(n.id, n)
    for (const l of s.links) this.links.set(linkKey(l), l)
    this.seq = s.seq
  }

  applyPatch(p: GraphPatch): void {
    for (const n of [...p.addNodes, ...p.updateNodes]) this.nodes.set(n.id, n)
    for (const id of p.removeNodeIds) this.nodes.delete(id)
    for (const l of p.addLinks) this.links.set(linkKey(l), l)
    for (const l of p.removeLinks) this.links.delete(linkKey(l))
    for (const id of p.removeNodeIds) for (const [k, l] of this.links) if (l.source === id || l.target === id) this.links.delete(k)
  }

  /**
   * The parent of a split child, read from the projected `child` edge — the projection derives
   * that edge from TaskNode.parentId, so parentage is DATA here, never inferred from the id.
   */
  parentOf(taskId: string): string | null {
    for (const l of this.links.values()) if (l.type === EDGE.child && l.target === taskId) return l.source
    return null
  }

  taskTitle(taskId: string): string | undefined {
    return this.nodes.get(taskId)?.label
  }
  taskStatus(taskId: string): string | undefined {
    return this.nodes.get(taskId)?.detail
  }
  tasks(): GraphNode[] {
    return [...this.nodes.values()].filter(n => n.type === 'task')
  }
}

export const graph = new GraphStore()
