import { foldLiveNotes, noteKey, type EventRecord } from '@orc/contracts'
import type { State } from '@orc/kernel'

export interface GraphNode {
  id: string
  type: 'task' | 'step' | 'artifact' | 'note' | 'model'
  label: string
  detail: string // task: status; step: run status or 'pending'; artifact: size; note: kind; model: provider
}
export interface GraphLink { source: string; target: string; type: string }
export interface Graph { nodes: GraphNode[]; links: GraphLink[] }

export interface GraphPatch {
  addNodes: GraphNode[]
  updateNodes: GraphNode[] // same id, changed label/detail (e.g. step status flip)
  removeNodeIds: string[]
  addLinks: GraphLink[]
  removeLinks: GraphLink[]
}
export const emptyPatch = (p: GraphPatch): boolean =>
  !p.addNodes.length && !p.updateNodes.length && !p.removeNodeIds.length && !p.addLinks.length && !p.removeLinks.length

// The graph vocabulary — every producer and consumer speaks through these, never literals.
export const EDGE = {
  child: 'child', plan: 'plan', depends: 'depends', out: 'out', wrote: 'wrote', uses: 'uses',
} as const
export type EdgeType = (typeof EDGE)[keyof typeof EDGE]

export const NODE_PREFIX = { step: 'step:', artifact: 'artifact:', note: 'note:', model: 'model:' } as const
export const modelNodeId = (ref: string): string => `${NODE_PREFIX.model}${ref}`

export const stepNodeId = (taskId: string, id: string): string => `${NODE_PREFIX.step}${taskId}:${id}`
export const artifactNodeId = (taskId: string, path: string): string => `${NODE_PREFIX.artifact}${taskId}:${path}`
export const noteNodeId = (scope: string, id: string): string => `${NODE_PREFIX.note}${noteKey(scope, id)}`
export const planScopeName = (taskId: string): string => `plan-${taskId}`

// The ONE events→graph projection. Every full load and (via diffGraphs) every patch comes from
// here, so no consumer can ever see a graph this function would not produce.
export function buildGraph(state: State, events: Array<Pick<EventRecord, 'kind' | 'payload'>>): Graph {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  for (const t of state.tasks.values()) {
    nodes.push({ id: t.id, type: 'task', label: t.title, detail: t.status })
    if (t.parentId && state.tasks.has(t.parentId)) links.push({ source: t.parentId, target: t.id, type: EDGE.child })
    const plans = state.plans.get(t.id)
    // versions are stored push-ordered and matched by their own version field (see fold's
    // plan_approved case) — never by array position
    const plan = plans?.approvedVersion != null ? plans.versions.find(v => v.version === plans.approvedVersion) : undefined
    for (const s of plan?.steps ?? []) {
      const run = state.steps.get(t.id)?.get(s.id)
      nodes.push({ id: stepNodeId(t.id, s.id), type: 'step', label: s.title, detail: run?.status ?? 'pending' })
      links.push({ source: t.id, target: stepNodeId(t.id, s.id), type: EDGE.plan })
      for (const dep of s.dependsOn) links.push({ source: stepNodeId(t.id, dep), target: stepNodeId(t.id, s.id), type: EDGE.depends })
    }
    for (const a of state.artifacts.get(t.id) ?? []) {
      const id = artifactNodeId(t.id, a.path)
      nodes.push({ id, type: 'artifact', label: a.path, detail: `${a.size}B` })
      links.push({ source: a.stepId ? stepNodeId(t.id, a.stepId) : t.id, target: id, type: EDGE.out })
    }
    // which model took this task over — one shared node per ref, so the graph shows every
    // task a model executed (the raw material for "was it a good choice")
    for (const ref of new Set((plan?.steps ?? []).map(s => s.modelRef))) {
      if (!nodes.some(n => n.id === modelNodeId(ref))) {
        const slash = ref.indexOf('/')
        nodes.push({ id: modelNodeId(ref), type: 'model', label: slash > 0 ? ref.slice(slash + 1) : ref, detail: slash > 0 ? ref.slice(0, slash) : '' })
      }
      links.push({ source: t.id, target: modelNodeId(ref), type: EDGE.uses })
    }
  }
  const live = foldLiveNotes(events)
  for (const { note, author } of live.values()) {
    nodes.push({ id: noteNodeId(note.scope, note.id), type: 'note', label: note.title, detail: note.kind })
    if (author.taskId && state.tasks.has(author.taskId))
      links.push({ source: author.taskId, target: noteNodeId(note.scope, note.id), type: EDGE.wrote })
    for (const l of note.links)
      if (live.has(noteKey(note.scope, l.id))) // links resolve same-scope, system-wide semantics
        links.push({ source: noteNodeId(note.scope, note.id), target: noteNodeId(note.scope, l.id), type: l.kind })
  }
  return { nodes, links }
}

const linkKey = (l: GraphLink): string => `${l.source}\u0000${l.target}\u0000${l.type}`

// Pure id-keyed diff between two projections — the ONE way patches are derived, so the patch
// stream can never drift from what a fresh full load would return.
export function diffGraphs(prev: Graph, next: Graph): GraphPatch {
  const prevN = new Map(prev.nodes.map(n => [n.id, n]))
  const nextN = new Map(next.nodes.map(n => [n.id, n]))
  const prevL = new Map(prev.links.map(l => [linkKey(l), l]))
  const nextL = new Map(next.links.map(l => [linkKey(l), l]))
  return {
    addNodes: next.nodes.filter(n => !prevN.has(n.id)),
    updateNodes: next.nodes.filter(n => {
      const p = prevN.get(n.id)
      return p !== undefined && (p.label !== n.label || p.detail !== n.detail)
    }),
    removeNodeIds: prev.nodes.filter(n => !nextN.has(n.id)).map(n => n.id),
    addLinks: next.links.filter(l => !prevL.has(linkKey(l))),
    removeLinks: prev.links.filter(l => !nextL.has(linkKey(l))),
  }
}
