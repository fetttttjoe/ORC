import { errorMessage, type EventRecord } from '@orc/contracts'
import { emptyFold, fold, foldInto, listProjectIds, openStorage, watchProjectIds, type FoldAcc, type ProjectIdsWatch, type Storage } from '@orc/kernel'
import { buildGraph, diffGraphs, emptyPatch, type Graph, type GraphPatch } from './graph'
import { summarizeEvent, type LogRow } from './summarize'
import type { ReadModel } from './views/view'

export interface SessionSnapshot { seq: number; graph: Graph }

// model is the state as of seq: consume it inside the callback, never keep or mutate it
export interface SessionUpdate { seq: number; patch: GraphPatch; event: EventRecord | null; summary: LogRow | null; model: ReadModel }
export type Unsubscribe = () => void

// name and dir are null until that project's session has been opened
export interface ProjectEntry { id: string; name: string | null; dir: string | null }

// the one live store every adapter subscribes to; what can be asked lives in the view registry
export interface ProjectSessions {
  projects(): Promise<ProjectEntry[]>
  // fires when the name-resolved list changes; row-deleting operations call notifyProjectsChanged
  subscribeProjects(cb: (projects: ProjectEntry[]) => void): Promise<Unsubscribe>
  notifyProjectsChanged(): Promise<void>
  // live, not a copy: take it, answer, discard; never hold it across an await or mutate it
  model(projectId: string): Promise<ReadModel>
  snapshot(projectId: string): Promise<SessionSnapshot>
  // fires on every event: patch may be empty; graph adapters filter on it, feed adapters use summary
  subscribe(projectId: string, cb: (u: SessionUpdate) => void): Promise<Unsubscribe>
  // catch-up for resume: one cumulative patch from a client's seq to now (null when current)
  since(projectId: string, fromSeq: number): Promise<SessionUpdate | null>
  // drops a cached session: the next read refolds; old SSE subscribers go silent
  reset(projectId: string): Promise<void>
  close(): Promise<void>
}

interface Session {
  storage: Storage
  events: EventRecord[]
  acc: FoldAcc
  graph: Graph
  seq: number
  subscribers: Set<(u: SessionUpdate) => void>
  unsubscribe: () => Promise<void>
}

export function createProjectSessions(opts: {
  url: string
  cwdProject?: { id: string; name: string; dir?: string }
}): ProjectSessions {
  const sessions = new Map<string, Promise<Session>>()

  // no copy: only as current as the tick it is read in; shared by model() and notifications
  const liveModel = (s: Session): ReadModel => ({ seq: s.seq, events: s.events, state: s.acc.state, graph: s.graph })

  async function open(projectId: string): Promise<Session> {
    const storage = await openStorage(opts.url, { projectId })
    const events = await storage.events.all()
    const acc = events.reduce(foldInto, emptyFold())
    const session: Session = {
      storage, events, acc,
      graph: buildGraph(acc.state),
      seq: events.at(-1)?.seq ?? 0,
      subscribers: new Set(),
      unsubscribe: async () => {},
    }
    // ponytail: refold-per-event is O(events); swap in an incremental applyEvent when logs get big
    const reload = async (): Promise<void> => {
      session.events = await storage.events.all()
      session.acc = session.events.reduce(foldInto, emptyFold())
      session.graph = buildGraph(session.acc.state)
      session.seq = session.events.at(-1)?.seq ?? 0
    }
    // built after the fold, before the callbacks, in the same tick
    const notify = (u: Omit<SessionUpdate, 'model'>): void => {
      const model = liveModel(session)
      for (const cb of session.subscribers) cb({ ...u, model })
    }
    // a re-created log never delivers an event, so the log reports truncation here
    const onReset = async (): Promise<void> => {
      const stale = session.graph
      await reload()
      notify({ seq: session.seq, patch: diffGraphs(stale, session.graph), event: null, summary: null })
    }
    session.unsubscribe = await storage.events.subscribe({ fromSeq: session.seq, onReset }, async e => {
      const oldest = session.events[0]?.seq ?? 0
      if (oldest !== 0 && await storage.events.earliestSeq() !== oldest) {
        const stale = session.graph
        await reload()
        notify({ seq: session.seq, patch: diffGraphs(stale, session.graph), event: e, summary: summarizeEvent(e) })
        return
      }
      session.events.push(e)
      foldInto(session.acc, e)
      const next = buildGraph(session.acc.state)
      const patch = diffGraphs(session.graph, next)
      session.graph = next
      session.seq = e.seq
      notify({ seq: e.seq, patch, event: e, summary: summarizeEvent(e) })
    })
    return session
  }

  const sessionFor = (projectId: string): Promise<Session> => {
    let s = sessions.get(projectId)
    if (!s) {
      s = open(projectId)
      sessions.set(projectId, s)
      // a failed open must not brick the project until restart — drop it so the next call retries
      s.catch(() => sessions.delete(projectId))
    }
    return s
  }

  // taken fresh per call, after the session-open await, so seq and arrays describe one moment
  const modelFor = async (projectId: string): Promise<ReadModel> => liveModel(await sessionFor(projectId))

  // listed = has events: purge re-seeds its identity event; a deleted project disappears
  const listProjects = async (ids?: string[]): Promise<ProjectEntry[]> => {
    return Promise.all((ids ?? await listProjectIds(opts.url)).map(async id => {
      // the identity event wins over cwd config; unopened foreign projects show a short id
      let name = id === opts.cwdProject?.id ? opts.cwdProject.name : null
      let dir = id === opts.cwdProject?.id ? opts.cwdProject.dir ?? null : null
      const cached = sessions.get(id)
      if (cached) {
        const s = await cached.catch(() => null)
        const identity = s?.acc.state.project
        if (identity) ({ name, dir } = identity)
      }
      return { id, name, dir }
    }))
  }

  // the diff runs over the name-resolved list, so membership and renames emit once
  const projectSubs = new Set<(ps: ProjectEntry[]) => void>()
  let projectsWatch: Promise<ProjectIdsWatch> | null = null
  let lastProjectsKey: string | null = null
  const emitProjects = async (ids?: string[]): Promise<void> => {
    if (projectSubs.size === 0) return
    const ps = await listProjects(ids)
    const key = JSON.stringify(ps)
    if (key === lastProjectsKey) return
    lastProjectsKey = key
    for (const cb of projectSubs) cb(ps)
  }

  return {
    projects: () => listProjects(),

    async subscribeProjects(cb) {
      projectSubs.add(cb)
      projectsWatch ??= watchProjectIds(opts.url, ids => {
        void emitProjects(ids).catch(err => console.warn(`projects push failed: ${errorMessage(err)}`))
      })
      // a failed watch open must not brick the push until restart — retry on the next subscribe
      await projectsWatch.catch(() => { projectsWatch = null })
      return () => { projectSubs.delete(cb) }
    },

    async notifyProjectsChanged() {
      await emitProjects()
    },

    model: modelFor,

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
      const patch = diffGraphs(buildGraph(fold(past)), s.graph)
      // taken in the same tick as the seq it is labelled with
      return emptyPatch(patch) ? null : { seq: s.seq, patch, event: null, summary: null, model: liveModel(s) }
    },

    async reset(projectId) {
      const p = sessions.get(projectId)
      if (!p) return
      sessions.delete(projectId)
      const s = await p.catch(() => null)
      if (s) { await s.unsubscribe(); await s.storage.close() }
    },

    async close() {
      if (projectsWatch) {
        const w = await projectsWatch.catch(() => null)
        await w?.close()
        projectsWatch = null
      }
      projectSubs.clear()
      for (const p of sessions.values()) {
        const s = await p.catch(() => null)
        if (s) { await s.unsubscribe(); await s.storage.close() }
      }
      sessions.clear()
    },
  }
}
