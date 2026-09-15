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
  // tasks only: the checkout the task is worked in. Every task has one (TaskNode.workspaceId is
  // required and set at creation — nothing re-homes a task), so a consumer can group the task list
  // by workspace without a second fold of the log; absent on every other node type. diffGraphs
  // deliberately does not compare it — it cannot change for an id that already exists.
  workspaceId?: string | undefined
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

// The node vocabulary, spelled ONCE. It was spelled four times — this module's consumers each
// re-typed it: the canvas colour map, the browser's wire schema, buildGraph's literals and the
// copilot's counts. A `model` node that gained a colour in one of them and not the others is the
// shape of bug that produces: nothing fails, the picture is just wrong. Derived types below make a
// new kind a compile error at every render site instead.
export const NODE_TYPES = ['task', 'step', 'artifact', 'note', 'model'] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const NODE_PREFIX = { step: 'step:', artifact: 'artifact:', note: 'note:', model: 'model:' } as const

// The ONE spelling of a link's identity. It lives here, not beside diffGraphs, because BOTH sides
// key links by it and the browser cannot import graph.ts (that module pulls @orc/contracts and
// @orc/kernel). It has now been re-spelled inline twice — most recently by the browser's graph
// store, which additionally embedded raw NUL bytes and so read as a binary file to git. Add a
// field to link identity in one copy only and the patch stream silently produces dead edges.
export const linkKey = (l: GraphLink): string => `${l.source}\u0000${l.target}\u0000${l.type}`

export const emptyPatch = (p: GraphPatch): boolean =>
  !p.addNodes.length && !p.updateNodes.length && !p.removeNodeIds.length && !p.addLinks.length && !p.removeLinks.length && !p.updateLinks.length

// /api/log's query vocabulary — one spelling for the server (searchParams.get) and the browser's
// query builder. Same rule as linkKey above: both sides speak it and neither may import the
// other, so the names live at the wire. `since`/`before` are the log's two paging directions.
export const LOG_PARAM = { task: 'task', limit: 'limit', since: 'since', before: 'before' } as const
