import { activation, DEFAULT_HALF_LIFE_DAYS, foldAccessCounts, foldLiveNotes, noteKey, STEP_RUN_STATUS, type EventRecord } from '@orc/contracts'
import type { State } from '@orc/kernel'

export interface GraphNode {
  id: string
  type: 'task' | 'step' | 'artifact' | 'note' | 'model'
  label: string
  detail: string // task: status; step: run status or 'pending'; artifact: size; note: kind; model: provider
  heat?: number // notes only: 0–1 activation heat (2dp) — recently-pulled knowledge renders hot; absent = cold
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

// project-chat metadata notes (display name, working directory) — infrastructure, not
// knowledge. Hidden from the graph and the chat narrative; fully present in the log/replay.
export const PROJECT_NAME_NOTE_ID = 'ui-project-name'
export const PROJECT_DIR_NOTE_ID = 'ui-project-dir'
const UI_META_NOTE_IDS = new Set<string>([PROJECT_NAME_NOTE_ID, PROJECT_DIR_NOTE_ID])
export const isUiMetaNote = (scope: string, id: string): boolean => scope === 'project' && UI_META_NOTE_IDS.has(id)
export const modelNodeId = (ref: string): string => `${NODE_PREFIX.model}${ref}`

export const stepNodeId = (taskId: string, id: string): string => `${NODE_PREFIX.step}${taskId}:${id}`
export const artifactNodeId = (taskId: string, path: string): string => `${NODE_PREFIX.artifact}${taskId}:${path}`
export const noteNodeId = (scope: string, id: string): string => `${NODE_PREFIX.note}${noteKey(scope, id)}`


// Options for the events→graph projection. `now` exists for deterministic tests (defaults to
// the wall clock); halfLifeDays feeds note heat and is threaded by the sessions layer from the
// project's config — the SAME value the store's neighbor ranking uses, so graph heat and CLI
// ranking always decay at one rate.
export interface GraphBuildOptions { now?: string; halfLifeDays?: number }

// The ONE events→graph projection. Every full load and (via diffGraphs) every patch comes from
// here, so no consumer can ever see a graph this function would not produce.
export function buildGraph(state: State, events: Array<Pick<EventRecord, 'kind' | 'payload'> & { ts?: string }>, opts: GraphBuildOptions = {}): Graph {
  const now = opts.now ?? new Date().toISOString()
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
      // single-step templates copy the task title onto the step — two same-named nodes read
      // as a duplicate insert; the step names itself. Running steps carry their live loop
      // progress so the graph shows plan iteration, not just that something works.
      const base = s.title === t.title ? `${s.title} · ${s.id}` : s.title
      const label = run?.status === STEP_RUN_STATUS.running ? `${base} · ${run.iterations}/${s.maxIterations}` : base
      nodes.push({ id: stepNodeId(t.id, s.id), type: 'step', label, detail: run?.status ?? 'pending' })
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
  const access = foldAccessCounts(events)
  // heat: log-scaled activation, saturating at ~50. Rounded to 2dp so closely-spaced rebuilds
  // don't churn the patch stream — slow drift across a long session still patches occasionally,
  // and that IS the fade (patches are idempotent, the cost is negligible). halfLifeDays arrives
  // from project config via the sessions layer — the same value the store's ranking uses.
  const heatOf = (k: string): number | undefined => {
    const stats = access.get(k)
    if (!stats) return undefined
    const act = activation(stats, now, opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) // AccessStats passes straight through
    if (act <= 0) return undefined
    return Math.round(Math.min(1, Math.log1p(act) / Math.log1p(50)) * 100) / 100
  }
  const live = foldLiveNotes(events)
  for (const { note, author } of live.values()) {
    if (isUiMetaNote(note.scope, note.id)) continue // chat metadata is not knowledge
    nodes.push({ id: noteNodeId(note.scope, note.id), type: 'note', label: note.title, detail: note.kind, heat: heatOf(noteKey(note.scope, note.id)) })
    if (author.taskId && state.tasks.has(author.taskId))
      links.push({ source: author.taskId, target: noteNodeId(note.scope, note.id), type: EDGE.wrote })
    for (const l of note.links) {
      // links resolve same-scope (system-wide semantics); for the HUMAN view only, an
      // unresolved link falls back to the project scope — plan subplans wire visibly into
      // the knowledge map (derived_from arch-overview/area-*) instead of dangling invisibly.
      // Agent traversal (memory_neighbors) keeps strict scoping.
      const targetScope = live.has(noteKey(note.scope, l.id)) ? note.scope
        : live.has(noteKey('project', l.id)) ? 'project' : null
      if (targetScope) links.push({ source: noteNodeId(note.scope, note.id), target: noteNodeId(targetScope, l.id), type: l.kind })
    }
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
      return p !== undefined && (p.label !== n.label || p.detail !== n.detail || p.heat !== n.heat)
    }),
    removeNodeIds: prev.nodes.filter(n => !nextN.has(n.id)).map(n => n.id),
    addLinks: next.links.filter(l => !prevL.has(linkKey(l))),
    removeLinks: prev.links.filter(l => !nextL.has(linkKey(l))),
  }
}
