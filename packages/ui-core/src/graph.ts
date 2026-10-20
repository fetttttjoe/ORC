import { StepRunStatus } from '@orc/contracts'
import type { State } from '@orc/kernel'

// wire shapes + vocabulary live in graph-wire.ts (zero-import, shared with the browser)
export { EDGE, NODE_PREFIX, emptyPatch, linkKey, type EdgeType, type Graph, type GraphLink, type GraphNode, type GraphPatch } from './graph-wire'
import { EDGE, linkKey, NODE_PREFIX, type Graph, type GraphLink, type GraphNode, type GraphPatch } from './graph-wire'

export const modelNodeId = (ref: string): string => `${NODE_PREFIX.model}${ref}`

export const stepNodeId = (taskId: string, id: string): string => `${NODE_PREFIX.step}${taskId}:${id}`
export const artifactNodeId = (taskId: string, path: string): string => `${NODE_PREFIX.artifact}${taskId}:${path}`

// the one events-to-graph projection: every full load and every patch comes from here
export function buildGraph(state: State): Graph {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  for (const t of state.tasks.values()) {
    nodes.push({ id: t.id, type: 'task', label: t.title, detail: t.status, workspaceId: t.workspaceId })
    if (t.parentId && state.tasks.has(t.parentId)) links.push({ source: t.parentId, target: t.id, type: EDGE.child })
    const plans = state.plans.get(t.id)
    // matched by the version field, never by array position (versions are push-ordered)
    const plan = plans?.approvedVersion != null ? plans.versions.find(v => v.version === plans.approvedVersion) : undefined
    for (const s of plan?.steps ?? []) {
      const run = state.steps.get(t.id)?.get(s.id)
      // a single-step template copies the task title onto its step: the step names itself instead
      const base = s.title === t.title ? `${s.title} · ${s.id}` : s.title
      const label = run?.status === StepRunStatus.running ? `${base} · ${run.iterations}/${s.maxIterations}` : base
      nodes.push({ id: stepNodeId(t.id, s.id), type: 'step', label, detail: run?.status ?? 'pending' })
      links.push({ source: t.id, target: stepNodeId(t.id, s.id), type: EDGE.plan })
      for (const dep of s.dependsOn) links.push({ source: stepNodeId(t.id, dep), target: stepNodeId(t.id, s.id), type: EDGE.depends })
    }
    // deduped by node id, newest wins: a path written twice must not yield two same-id nodes
    const artifacts = new Map<string, { path: string; size: number; stepId?: string | null }>()
    for (const a of state.artifacts.get(t.id) ?? []) artifacts.set(artifactNodeId(t.id, a.path), a)
    for (const [id, a] of artifacts) {
      nodes.push({ id, type: 'artifact', label: a.path, detail: `${a.size}B` })
      links.push({ source: a.stepId ? stepNodeId(t.id, a.stepId) : t.id, target: id, type: EDGE.out })
    }
    // one shared node per model ref, so the graph shows every task a model executed
    for (const ref of new Set((plan?.steps ?? []).map(s => s.modelRef))) {
      if (!nodes.some(n => n.id === modelNodeId(ref))) {
        const slash = ref.indexOf('/')
        nodes.push({ id: modelNodeId(ref), type: 'model', label: slash > 0 ? ref.slice(slash + 1) : ref, detail: slash > 0 ? ref.slice(0, slash) : '' })
      }
      links.push({ source: t.id, target: modelNodeId(ref), type: EDGE.uses })
    }
  }
  return { nodes, links }
}


// the one way patches are derived, so the stream cannot drift from a fresh full load
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
