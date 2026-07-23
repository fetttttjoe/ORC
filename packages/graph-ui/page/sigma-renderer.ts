import { MultiGraph } from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import Sigma from 'sigma'
import type { Graph, GraphLink, GraphNode, GraphPatch } from '@orc/ui-core'
import type { GraphRenderer } from './renderer'
import { PALETTE } from '@orc/ui-core/palette'
import { colorFor, isActive } from './status-style'

const EDGE_COLOR = PALETTE.edge
const SETTLE_MS = 3_000 // keep the worker layout running this long after the last change
const BASE_SIZE = 4
const FLASH_MS = 4_000 // how long an event ripple keeps a node hot
const PULSE_MS = 550 // pulse half-period — running/hot nodes breathe at ~1Hz

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
    // sigma only tracks WINDOW resizes; the container resizes without one (flex settling on
    // initial load, the detail panel opening from a deep link, chat/split/graph mode switches)
    // and sigma keeps rendering into stale dimensions — the reload-time clipped-graph bug.
    this.resizeObserver = new ResizeObserver(() => this.sigma.resize())
    this.resizeObserver.observe(container)
  }

  private readonly resizeObserver: ResizeObserver

  focus(nodeIds: Set<string> | null): void {
    this.focusSet = nodeIds
    this.sigma.refresh()
  }

  setGraph(g: Graph): void {
    this.graph.clear()
    this.active.clear()
    this.hot.clear()
    for (const n of g.nodes) this.addNode(n)
    for (const l of g.links) this.addLink(l)
    this.restartLayout()
  }

  applyPatch(p: GraphPatch): void {
    for (const n of p.addNodes) this.addNode(n, p.addLinks)
    for (const n of p.updateNodes)
      if (this.graph.hasNode(n.id)) {
        // detail carries the lifecycle — merging it (and its color) is what makes live
        // status flips visible; dropping it was the invisible-run bug
        const base = BASE_SIZE + (n.heat ?? 0) * 4
        this.graph.mergeNodeAttributes(n.id, { label: n.label, nodeType: n.type, detail: n.detail, color: colorFor(n.type, n.detail), baseSize: base, ...(this.selected === n.id ? {} : { size: base }) })
        this.trackActivity(n)
      }
    for (const id of p.removeNodeIds) if (this.graph.hasNode(id)) { this.graph.dropNode(id); this.active.delete(id); this.hot.delete(id) } // incident edges drop too
    for (const l of p.addLinks) this.addLink(l)
    for (const l of p.removeLinks) if (this.graph.hasEdge(edgeKey(l))) this.graph.dropEdge(edgeKey(l))
    this.restartLayout()
  }

  // ---- live activity markers ----
  private readonly active = new Set<string>() // nodes whose status is `running`
  private readonly hot = new Map<string, number>() // event-ripple nodes → expiry (epoch ms)
  private pulsing = new Set<string>() // what the last tick inflated, so it can be restored
  private pulseTimer: ReturnType<typeof setInterval> | null = null
  private phase = false

  flash(nodeIds: string[]): void {
    const until = Date.now() + FLASH_MS
    for (const id of nodeIds) if (this.graph.hasNode(id)) this.hot.set(id, until)
    if (this.hot.size) this.ensurePulse()
  }

  private trackActivity(n: GraphNode): void {
    if (isActive(n.type, n.detail)) { this.active.add(n.id); this.ensurePulse() }
    else this.active.delete(n.id)
  }

  private ensurePulse(): void {
    if (!this.pulseTimer) this.pulseTimer = setInterval(() => this.pulse(), PULSE_MS)
  }

  private pulse(): void {
    const now = Date.now()
    this.phase = !this.phase
    for (const [id, until] of this.hot) if (until <= now || !this.graph.hasNode(id)) this.hot.delete(id)
    const live = new Set([...this.active].filter(id => this.graph.hasNode(id)))
    for (const id of this.hot.keys()) live.add(id)
    for (const id of this.pulsing) if (!live.has(id) && this.graph.hasNode(id) && id !== this.selected) this.graph.setNodeAttribute(id, 'size', this.baseOf(id))
    for (const id of live) if (id !== this.selected) this.graph.setNodeAttribute(id, 'size', this.phase ? this.baseOf(id) + 2.5 : this.baseOf(id) + 0.5)
    this.pulsing = live
    if (!live.size && this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null }
  }

  private baseOf(id: string): number {
    const b: unknown = this.graph.getNodeAttribute(id, 'baseSize')
    return typeof b === 'number' ? b : BASE_SIZE
  }

  onNodeClick(cb: (nodeId: string) => void): void {
    this.clickCb = cb
  }

  private selected: string | null = null
  select(nodeId: string | null): void {
    if (this.selected === nodeId) return
    if (this.selected && this.graph.hasNode(this.selected))
      this.graph.mergeNodeAttributes(this.selected, { highlighted: false, size: this.baseOf(this.selected) })
    this.selected = nodeId
    if (nodeId && this.graph.hasNode(nodeId))
      this.graph.mergeNodeAttributes(nodeId, { highlighted: true, size: this.baseOf(nodeId) + 3 })
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (this.pulseTimer) clearInterval(this.pulseTimer)
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
    const base = BASE_SIZE + (n.heat ?? 0) * 4
    this.graph.addNode(n.id, { ...at, size: base, baseSize: base, label: n.label, color: colorFor(n.type, n.detail), nodeType: n.type, detail: n.detail })
    this.trackActivity(n)
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
