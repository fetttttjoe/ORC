import { errorMessage, type EventRecord } from '@orc/contracts'
import { emptyFold, fold, foldInto, listProjectIds, openStorage, watchProjectIds, type FoldAcc, type ProjectIdsWatch, type Storage } from '@orc/kernel'
import { buildGraph, diffGraphs, emptyPatch, type Graph, type GraphPatch } from './graph'
import { summarizeEvent, type LogRow } from './summarize'
import type { ReadModel } from './views/view'

export interface SessionSnapshot { seq: number; graph: Graph }

/**
 * One notification: what changed, and the read model it changed INTO.
 *
 * patch may be EMPTY (adapters filter); summary and event are null for a synthetic update —
 * since()'s catch-up, and the repair a truncated log produces.
 *
 * `model` is the session's state AS OF `seq`, handed over rather than fetched back. A subscriber
 * that took its own would get whatever the session held by the time it asked, which is still this
 * moment only while the event pump happens to be serial and each handler happens to await before
 * folding — so a frame's `seq` and the state it described were two facts kept equal by an invariant
 * two packages away, with nothing failing when it moved. Handing it over makes that unaskable.
 *
 * It carries the same contract as ProjectSessions.model, with the callback's tick as the window:
 * CONSUME IT INSIDE THE CALLBACK, never keep it, never mutate it. The arrays and maps are the
 * session's own: the next event appends to `events`/`state` in place and replaces `graph`
 * wholesale (a fresh `buildGraph` result each fold) — either way, a held reference stops tracking,
 * so consume it inside the callback.
 */
export interface SessionUpdate { seq: number; patch: GraphPatch; event: EventRecord | null; summary: LogRow | null; model: ReadModel }
export type Unsubscribe = () => void

// One chats-list entry: id always; name/dir resolve from the project's identity event and are
// null until that project's session has been opened (foreign, never-viewed projects).
export interface ProjectEntry { id: string; name: string | null; dir: string | null }

// The one live store every adapter (web server, future TUI) subscribes to. Transport-free, and
// read-free: callers get the read model itself, graph snapshots and per-event patches — never SQL,
// never HTTP, and never a per-question method. What can be ASKED of the model lives in the view
// registry, so a new question costs no method here and none in any adapter.
export interface ProjectSessions {
  projects(): Promise<ProjectEntry[]>
  // membership/name push: fires with the fresh, name-resolved list whenever it actually changed —
  // new chats appear in every adapter without a reload. Backed by the storage-level
  // watchProjectIds wake (the shared NOTIFY channel). Row-deleting operations emit no NOTIFY;
  // the adapter that performs them calls notifyProjectsChanged() afterwards.
  subscribeProjects(cb: (projects: ProjectEntry[]) => void): Promise<Unsubscribe>
  notifyProjectsChanged(): Promise<void>
  // The cache under the narrow face a view reads: folded state and the events behind it, with no
  // route from it back to storage or the subscriber set. A door answers a read by handing this to
  // readView, so adding a view costs no method here and no method in any adapter.
  //
  // LIVE, not a copy — the arrays and maps are the session's own, and the subscriber path appends
  // to them as events arrive. So a model is coherent only within the tick it was taken in: TAKE
  // IT, ANSWER, DISCARD. Never hold one across an await, and never mutate what it hands back. The
  // failure it guards against is an envelope whose `seq` was read before an await and whose rows
  // were read after — a client told "you are current at 41" while holding rows up to 43 never asks
  // for 42 and 43 again, and the two events are simply gone from its feed. Copying instead would
  // cost a full fold per read, which is the expense this cache exists to avoid.
  model(projectId: string): Promise<ReadModel>
  snapshot(projectId: string): Promise<SessionSnapshot>
  // fires on EVERY event: the patch may be empty, the summary/log row is always present —
  // graph adapters filter on the patch, feed adapters (log, chat, TUI) consume the summary
  subscribe(projectId: string, cb: (u: SessionUpdate) => void): Promise<Unsubscribe>
  // catch-up for resume: one cumulative patch from a client's seq to now (null when current)
  since(projectId: string, fromSeq: number): Promise<SessionUpdate | null>
  // drop a cached session (after a purge): the next read refolds from the log. Live SSE
  // subscribers of the old session go silent — the initiating client re-attaches itself;
  // other tabs stay stale until their next reload.
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

  // The session's own arrays under the narrow face a view reads — no copy, so this is only as
  // current as the tick it is read in. The ONE place the model is assembled, shared by model() and
  // by every notification.
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
    // ponytail: refold-per-event is O(events) per event — swap in an incremental kernel
    // applyEvent behind this same interface when a log gets big
    // The cached log is append-only in memory, but the real one can be TRUNCATED out of band —
    // `orc purge`, deleting a chat — and no event announces that. Without this the server keeps
    // folding deleted history: the UI shows tasks that no longer exist, and cannot
    // recover until the process restarts. One indexed lookup per event, against the oldest row we
    // still believe in; when it is gone, the cache is rebuilt from the log and the diff removes
    // the ghosts like any other change.
    const reload = async (): Promise<void> => {
      session.events = await storage.events.all()
      session.acc = session.events.reduce(foldInto, emptyFold())
      session.graph = buildGraph(session.acc.state)
      session.seq = session.events.at(-1)?.seq ?? 0
    }
    // Every notification carries the state it notified ABOUT, built here — after the fold, before
    // the callbacks, inside the same tick.
    const notify = (u: Omit<SessionUpdate, 'model'>): void => {
      const model = liveModel(session)
      for (const cb of session.subscribers) cb({ ...u, model })
    }
    // The truncation check below needs an event to arrive; a re-created log never delivers one
    // (our cursor sits above every new row), so the log reports it here instead.
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

  // Taken fresh per call, and only after the await that guarantees the session is open: `seq` and
  // the arrays beside it then describe one moment. Holding the result instead — see the contract
  // on ProjectSessions.model — lets them describe two.
  const modelFor = async (projectId: string): Promise<ReadModel> => liveModel(await sessionFor(projectId))

  // listed = has events. Purge keeps its project listed by re-seeding its identity event;
  // a DELETED project has zero events and correctly disappears — even the server's own.
  const listProjects = async (ids?: string[]): Promise<ProjectEntry[]> => {
    return Promise.all((ids ?? await listProjectIds(opts.url)).map(async id => {
      // the identity event (in already-open sessions) wins over the cwd config values; unopened
      // foreign projects show a short id until first opened
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

  // chats-list push: the watch wakes on every append anywhere; the authoritative diff happens
  // here over the NAME-RESOLVED list, so both membership changes and renames emit exactly once.
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
      // the model beside the patch is the state the catch-up brings the caller UP TO, taken in the
      // same tick as the `seq` it is labelled with
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
