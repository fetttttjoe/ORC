import { EVENT_KIND, MemoryAccessedPayload, foldLiveNotes, noteKey, type EventRecord, type Plan } from '@orc/contracts'
import { fold, listProjectIds, openStorage, taskUsage, type State, type Storage } from '@orc/kernel'
import { buildGraph, diffGraphs, emptyPatch, type Graph, type GraphPatch } from './graph'
import { summarizeEvent, type LogRow } from './summarize'
import { foldTranscript, type TranscriptItem } from './transcript'

export interface SessionSnapshot { seq: number; graph: Graph }
// patch may be EMPTY (adapters filter); summary is null only for since()'s synthetic catch-up
export interface SessionUpdate { seq: number; patch: GraphPatch; event: EventRecord | null; summary: LogRow | null }
export type Unsubscribe = () => void

// The one live store every adapter (web server, future TUI) subscribes to. Transport-free:
// callers get snapshots, per-event patches, catch-up patches, and node detail — never SQL,
// never HTTP.
export interface ProjectSessions {
  projects(): Promise<Array<{ id: string; name: string | null }>>
  snapshot(projectId: string): Promise<SessionSnapshot>
  // fires on EVERY event: the patch may be empty, the summary/log row is always present —
  // graph adapters filter on the patch, feed adapters (log, chat, TUI) consume the summary
  subscribe(projectId: string, cb: (u: SessionUpdate) => void): Promise<Unsubscribe>
  // catch-up for resume: one cumulative patch from a client's seq to now (null when current)
  since(projectId: string, fromSeq: number): Promise<SessionUpdate | null>
  nodeDetail(projectId: string, nodeId: string): Promise<unknown | null>
  transcript(projectId: string, taskId: string, stepId?: string): Promise<TranscriptItem[]>
  taskPlans(projectId: string, taskId: string): Promise<{ versions: Plan[]; approvedVersion: number | null } | null>
  log(projectId: string, opts?: { taskId?: string; limit?: number }): Promise<LogRow[]>
  close(): Promise<void>
}

interface Session {
  storage: Storage
  events: EventRecord[]
  state: State
  graph: Graph
  seq: number
  subscribers: Set<(u: SessionUpdate) => void>
  unsubscribe: () => Promise<void>
}

export function createProjectSessions(opts: {
  url: string
  cwdProject?: { id: string; name: string }
}): ProjectSessions {
  const sessions = new Map<string, Promise<Session>>()

  async function open(projectId: string): Promise<Session> {
    const storage = await openStorage(opts.url, { projectId })
    const events = await storage.events.all()
    const state = fold(events)
    const session: Session = {
      storage, events, state,
      graph: buildGraph(state, events),
      seq: events.at(-1)?.seq ?? 0,
      subscribers: new Set(),
      unsubscribe: async () => {},
    }
    // ponytail: refold-per-event is O(events) per event — swap in an incremental kernel
    // applyEvent behind this same interface when a log gets big
    session.unsubscribe = await storage.events.subscribe({ fromSeq: session.seq }, e => {
      session.events.push(e)
      session.state = fold(session.events)
      const next = buildGraph(session.state, session.events)
      const patch = diffGraphs(session.graph, next)
      session.graph = next
      session.seq = e.seq
      const summary = summarizeEvent(e)
      for (const cb of session.subscribers) cb({ seq: e.seq, patch, event: e, summary })
    })
    return session
  }

  const sessionFor = (projectId: string): Promise<Session> => {
    let s = sessions.get(projectId)
    if (!s) { s = open(projectId); sessions.set(projectId, s) }
    return s
  }

  return {
    async projects() {
      const ids = await listProjectIds(opts.url)
      return ids.map(id => ({ id, name: id === opts.cwdProject?.id ? opts.cwdProject.name : null }))
    },

    async snapshot(projectId) {
      const s = await sessionFor(projectId)
      return { seq: s.seq, graph: s.graph }
    },

    async subscribe(projectId, cb) {
      const s = await sessionFor(projectId)
      s.subscribers.add(cb)
      return () => s.subscribers.delete(cb)
    },

    async since(projectId, fromSeq) {
      const s = await sessionFor(projectId)
      if (fromSeq >= s.seq) return null
      const past = s.events.filter(e => e.seq <= fromSeq)
      const patch = diffGraphs(buildGraph(fold(past), past), s.graph)
      return emptyPatch(patch) ? null : { seq: s.seq, patch, event: null, summary: null }
    },

    async nodeDetail(projectId, nodeId) {
      const s = await sessionFor(projectId)
      if (nodeId.startsWith('step:')) {
        const [, taskId, stepId] = nodeId.split(':')
        if (!taskId || !stepId) return null
        const plans = s.state.plans.get(taskId)
        const plan = plans?.approvedVersion != null ? plans.versions.find(v => v.version === plans.approvedVersion) : undefined
        const step = plan?.steps.find(st => st.id === stepId)
        if (!step) return null
        return { step, run: s.state.steps.get(taskId)?.get(stepId) ?? null }
      }
      if (nodeId.startsWith('artifact:')) {
        const [, taskId, ...pathParts] = nodeId.split(':')
        const path = pathParts.join(':') // artifact paths may contain ':'
        return (s.state.artifacts.get(taskId ?? '') ?? []).find(a => a.path === path) ?? null
      }
      if (nodeId.startsWith('note:')) {
        const key = nodeId.slice('note:'.length) // `${scope}\u0000${id}`
        const live = foldLiveNotes(s.events)
        const payload = live.get(key)
        if (!payload) return null
        const [scope, id] = key.split('\u0000')
        const hits = s.events.filter(e => {
          if (e.kind !== EVENT_KIND.memory_accessed) return false
          const p = MemoryAccessedPayload.safeParse(e.payload)
          return p.success && p.data.id === id && p.data.scope === scope
        }).length
        // backlinks: notes whose links target this note (links resolve same-scope)
        const backlinks = [...live.values()]
          .filter(({ note }) => note.scope === scope && note.links.some(l => l.id === id))
          .map(({ note }) => ({ id: note.id, scope: note.scope, title: note.title, kind: note.kind }))
        return { ...payload, hits, backlinks }
      }
      const task = s.state.tasks.get(nodeId)
      if (!task) return null
      return {
        task,
        usage: taskUsage(s.state, nodeId),
        steps: [...(s.state.steps.get(nodeId)?.values() ?? [])],
        artifacts: s.state.artifacts.get(nodeId) ?? [],
      }
    },

    async transcript(projectId, taskId, stepId) {
      const s = await sessionFor(projectId)
      return foldTranscript(s.events, taskId, stepId)
    },

    async taskPlans(projectId, taskId) {
      const s = await sessionFor(projectId)
      const tp = s.state.plans.get(taskId)
      return tp ? { versions: tp.versions, approvedVersion: tp.approvedVersion } : null
    },

    async log(projectId, opts = {}) {
      const s = await sessionFor(projectId)
      const limit = opts.limit ?? 200
      // memory events are project-scoped (taskId null) — always included in a task view
      const rows = (opts.taskId ? s.events.filter(e => e.taskId === opts.taskId || e.taskId === null) : s.events)
        .slice(-limit).map(summarizeEvent)
      return rows
    },

    async close() {
      for (const p of sessions.values()) {
        const s = await p.catch(() => null)
        if (s) { await s.unsubscribe(); await s.storage.close() }
      }
      sessions.clear()
    },
  }
}
