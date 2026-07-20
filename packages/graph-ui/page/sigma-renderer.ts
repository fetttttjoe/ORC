import { MultiGraph } from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import Sigma from 'sigma'
import type { Graph, GraphLink, GraphNode, GraphPatch } from '@orc/ui-core'
import type { GraphRenderer } from './renderer'

const COLORS: Record<GraphNode['type'], string> = {
  task: '#7aa2f7', step: '#9ece6a', artifact: '#e0af68', note: '#bb9af7',
}
const EDGE_COLOR = '#3b3b47'
const SETTLE_MS = 3_000 // keep the worker layout running this long after the last change

const edgeKey = (l: GraphLink): string => `${l.source}\u0000${l.target}\u0000${l.type}`

export class SigmaRenderer implements GraphRenderer {
  private readonly graph = new MultiGraph()
  private readonly sigma: Sigma
  private layout: FA2Layout | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private clickCb: ((nodeId: string) => void) | null = null

  private focusSet: Set<string> | null = null

  constructor(container: HTMLElement) {
    this.sigma = new Sigma(this.graph, container, {
      labelColor: { color: '#ddd' },
      defaultEdgeColor: EDGE_COLOR,
      labelRenderedSizeThreshold: 8, // labels only when zoomed in enough — keeps big graphs legible
      // focus mode: everything outside the set fades into the background, labels off
      nodeReducer: (node, data) =>
        this.focusSet && !this.focusSet.has(node) ? { ...data, color: '#22222a', label: '', zIndex: 0 } : data,
      edgeReducer: (edge, data) => {
        if (!this.focusSet) return data
        const [s, t] = this.graph.extremities(edge)
        return this.focusSet.has(s!) && this.focusSet.has(t!) ? data : { ...data, color: '#1a1a20' }
      },
    })
    this.sigma.on('clickNode', ({ node }) => this.clickCb?.(node))
  }

  focus(nodeIds: Set<string> | null): void {
    this.focusSet = nodeIds
    this.sigma.refresh()
  }

  setGraph(g: Graph): void {
    this.graph.clear()
    for (const n of g.nodes) this.addNode(n)
    for (const l of g.links) this.addLink(l)
    this.restartLayout()
  }

  applyPatch(p: GraphPatch): void {
    for (const n of p.addNodes) this.addNode(n, p.addLinks)
    for (const n of p.updateNodes)
      if (this.graph.hasNode(n.id)) this.graph.mergeNodeAttributes(n.id, { label: n.label, nodeType: n.type })
    for (const id of p.removeNodeIds) if (this.graph.hasNode(id)) this.graph.dropNode(id) // incident edges drop too
    for (const l of p.addLinks) this.addLink(l)
    for (const l of p.removeLinks) if (this.graph.hasEdge(edgeKey(l))) this.graph.dropEdge(edgeKey(l))
    this.restartLayout()
  }

  onNodeClick(cb: (nodeId: string) => void): void {
    this.clickCb = cb
  }

  private selected: string | null = null
  select(nodeId: string | null): void {
    if (this.selected === nodeId) return
    if (this.selected && this.graph.hasNode(this.selected))
      this.graph.mergeNodeAttributes(this.selected, { highlighted: false, size: 4 })
    this.selected = nodeId
    if (nodeId && this.graph.hasNode(nodeId))
      this.graph.mergeNodeAttributes(nodeId, { highlighted: true, size: 7 })
  }

  destroy(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.layout?.kill()
    this.sigma.kill()
  }

  // new nodes spawn near a linked neighbor (they grow out of their cluster) or at random
  private addNode(n: GraphNode, contextLinks: GraphLink[] = []): void {
    if (this.graph.hasNode(n.id)) return
    const neighborId = contextLinks
      .filter(l => l.source === n.id || l.target === n.id)
      .map(l => (l.source === n.id ? l.target : l.source))
      .find(id => this.graph.hasNode(id))
    const at = neighborId
      ? { x: this.graph.getNodeAttribute(neighborId, 'x') + (Math.random() - 0.5), y: this.graph.getNodeAttribute(neighborId, 'y') + (Math.random() - 0.5) }
      : { x: Math.random() * 10, y: Math.random() * 10 }
    this.graph.addNode(n.id, { ...at, size: 4, label: n.label, color: COLORS[n.type], nodeType: n.type })
  }

  private addLink(l: GraphLink): void {
    if (this.graph.hasEdge(edgeKey(l)) || !this.graph.hasNode(l.source) || !this.graph.hasNode(l.target)) return
    this.graph.addEdgeWithKey(edgeKey(l), l.source, l.target, { color: EDGE_COLOR, linkType: l.type })
  }

  private restartLayout(): void {
    if (this.graph.order === 0) return
    if (!this.layout) this.layout = new FA2Layout(this.graph, { settings: forceAtlas2.inferSettings(this.graph) })
    if (!this.layout.isRunning()) this.layout.start()
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => this.layout?.stop(), SETTLE_MS)
  }
}
