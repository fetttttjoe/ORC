// zero imports: the browser takes the wire vocabulary without the projection's server chain
export interface GraphNode {
  id: string
  type: 'task' | 'step' | 'artifact' | 'model'
  label: string
  detail: string // task: status; step: run status or 'pending'; artifact: size; model: provider
  // tasks only: every task has a workspace; diffGraphs does not compare it, it cannot change
  workspaceId?: string | undefined // `| undefined`: what a zod `.optional()` infers under exactOptionalPropertyTypes
}
export interface GraphLink {
  source: string
  target: string
  type: string
}
export interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
}

export interface GraphPatch {
  addNodes: GraphNode[]
  updateNodes: GraphNode[] // same id, changed label/detail (e.g. step status flip)
  removeNodeIds: string[]
  addLinks: GraphLink[]
  removeLinks: GraphLink[]
}

// every producer and consumer speaks through these, never literals
export const EDGE = {
  child: 'child', plan: 'plan', depends: 'depends', out: 'out', uses: 'uses',
} as const
export type EdgeType = (typeof EDGE)[keyof typeof EDGE]

// spelled once: derived types make a new kind a compile error at every render site
export const NODE_TYPES = ['task', 'step', 'artifact', 'model'] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const NODE_PREFIX = { step: 'step:', artifact: 'artifact:', model: 'model:' } as const

// both sides key links by it and the browser cannot import graph.ts; keep the NUL separator
export const linkKey = (l: GraphLink): string => `${l.source}\u0000${l.target}\u0000${l.type}`

export const emptyPatch = (p: GraphPatch): boolean =>
  !p.addNodes.length && !p.updateNodes.length && !p.removeNodeIds.length && !p.addLinks.length && !p.removeLinks.length
