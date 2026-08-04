import type { Edge, Node } from '@xyflow/svelte'
import { planLayout, type LayerableStep } from './plan-layout'
import { DEFAULT_GEOMETRY, planGeometry, type GeometrySpec } from './plan-geometry'
import { STEP_STATUS, waveState, type WaveState } from './plan-status'

/**
 * The ONE adapter from a plan to a Svelte Flow graph. It is the only module in this feature that
 * knows Svelte Flow exists: layout is graph theory, geometry is arithmetic, editing is plan rules,
 * and all three stay usable if the renderer is ever swapped again (this is the third one).
 *
 * Waves become SUBFLOWS — a container node per rank with its steps as children (parentId +
 * extent:'parent'). That is what makes "these three run together" visible as a band instead of
 * something the reader has to infer from three nodes happening to share a column.
 */
export interface FlowStep extends LayerableStep {
  title: string
}

export interface PlanFlowOptions {
  /** run status per step id; anything unknown is pending */
  statusOf?: ((id: string) => string | undefined) | undefined
  spec?: GeometrySpec | undefined
  /** when true the canvas offers connection handles — the pre-approval editor's entry point */
  editable?: boolean | undefined
}

export interface PlanFlow {
  nodes: Node[]
  edges: Edge[]
  /** the drawing's own height — the caller sizes its canvas box from it */
  height: number
}

export interface WaveNodeData extends Record<string, unknown> {
  rank: number
  count: number
  state: WaveState
}

export interface StepNodeData extends Record<string, unknown> {
  title: string
  status: string
  editable: boolean
}

export function planToFlow(steps: readonly FlowStep[], opts: PlanFlowOptions = {}): PlanFlow {
  const { statusOf, spec = DEFAULT_GEOMETRY, editable = false } = opts
  const status = (id: string): string => statusOf?.(id) ?? STEP_STATUS.pending

  const layout = planLayout(steps)
  const geometry = planGeometry(layout.steps, spec)
  const titleOf = new Map(steps.map(s => [s.id, s.title]))

  const inRank = Map.groupBy(layout.steps, p => p.rank)
  const statusesInRank = new Map([...inRank].map(([r, ps]) => [r, ps.map(p => status(p.id))]))

  // Containers first. Svelte Flow resolves parentId against nodes EARLIER in the array, so a child
  // listed before its group renders at the canvas origin instead of inside it — order is load-
  // bearing here, not cosmetic.
  const groups: Node[] = geometry.groups.map(g => ({
    id: g.id,
    type: 'wave',
    position: { x: g.x, y: g.y },
    width: g.width,
    height: g.height,
    // a container is scenery: dragging or selecting it would move a wave, which means nothing
    draggable: false,
    selectable: false,
    data: { rank: g.rank, count: g.count, state: waveState(statusesInRank.get(g.rank) ?? []) } satisfies WaveNodeData,
  }))

  const children: Node[] = geometry.steps.map(s => ({
    id: s.id,
    type: 'step',
    parentId: s.groupId,
    extent: 'parent',
    position: { x: s.x, y: s.y },
    width: s.width,
    height: s.height,
    draggable: false, // position carries meaning (its wave); a dragged step would lie about when it runs
    data: { title: titleOf.get(s.id) ?? s.id, status: status(s.id), editable } satisfies StepNodeData,
  }))

  return {
    nodes: [...groups, ...children],
    edges: layout.edges.map(e => ({
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      // The dashes move only on the edge FEEDING work that is happening now, so motion on the
      // canvas always means "this is what the run is waiting on". Animating every edge would make
      // a finished plan look busy and cost a repaint per frame for nothing.
      animated: status(e.to) === STEP_STATUS.running,
    })),
    height: geometry.height,
  }
}
