// The graph WIRE vocabulary — shapes and constants both the server projection and the browser
// speak. Zero imports on purpose (the cluster.ts shape): the browser bundle must be able to take
// this without dragging the projection's server dependencies, and one spelling here is what stops
// producer and consumer drifting apart on a field name (they did once: the client read `kind`
// where the wire sends `type`, which silently collapsed every edge into one key).
export interface GraphNode {
  id: string
  type: 'task' | 'step' | 'artifact' | 'note' | 'model'
  label: string
  detail: string // task: status; step: run status or 'pending'; artifact: size; note: kind; model: provider
  // `| undefined` is load-bearing under exactOptionalPropertyTypes: the browser gets these shapes
  // out of a zod parser, whose `.optional()` infers `number | undefined`. Without it a PARSED node
  // is not assignable to the type that declares the wire, and the app compiled only because a
  // hand-written duplicate of this shape stood in for the parsed one.
  heat?: number | undefined // notes only: 0–1 activation heat (2dp) — recently-pulled knowledge renders hot; absent = cold
}
export interface GraphLink {
  source: string
  target: string
  type: string
  heat?: number | undefined // note-link edges only: 0–1 edge activation heat (2dp) — walked connections render hot
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
  updateLinks: GraphLink[] // same-key link, heat changed — the edge twin of updateNodes
}

// Every producer and consumer speaks through these, never literals.
export const EDGE = {
  child: 'child', plan: 'plan', depends: 'depends', out: 'out', wrote: 'wrote', uses: 'uses',
} as const
export type EdgeType = (typeof EDGE)[keyof typeof EDGE]

export const NODE_PREFIX = { step: 'step:', artifact: 'artifact:', note: 'note:', model: 'model:' } as const

export const emptyPatch = (p: GraphPatch): boolean =>
  !p.addNodes.length && !p.updateNodes.length && !p.removeNodeIds.length && !p.addLinks.length && !p.removeLinks.length && !p.updateLinks.length
