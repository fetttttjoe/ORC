import { EVENT_KIND, ModelsDiscoveredPayload, ZERO_USAGE, addUsage, emptyMemoryFold, errorMessage, foldMemory, foldMemoryInto, noteKey, noteLabel, type EventRecord, type MemoryFold, type Plan, type Usage } from '@orc/contracts'
import { emptyFold, fold, foldInto, foldPlanNotes, listProjectIds, openStorage, planScope, stepUsage, taskUsage, watchProjectIds, type FoldAcc, type ProjectIdsWatch, type Storage } from '@orc/kernel'
import { NODE_PREFIX, PROJECT_DIR_NOTE_ID, PROJECT_NAME_NOTE_ID, buildGraph, diffGraphs, emptyPatch, type Graph, type GraphPatch } from './graph'
import { decompositionMermaid, planMermaid, todoWaves, type StepStatusEntry, type TodoWave } from './diagram'

// the project's display name / working directory live in memory notes — event-sourced,
// rebuild-safe, no schema; ids + view filtering live in graph.ts (imported below)

// latest models_discovered per provider IS the catalog (append-on-change upstream)
function foldModelCatalog(events: Array<Pick<EventRecord, 'kind' | 'payload'>>): Map<string, string[]> {
  const catalog = new Map<string, string[]>()
  for (const e of events) {
    if (e.kind !== EVENT_KIND.models_discovered) continue
    const p = ModelsDiscoveredPayload.safeParse(e.payload)
    if (p.success) catalog.set(p.data.providerId, p.data.models)
  }
  return catalog
}
import { shouldAdmitLogRow, summarizeEvent, type LogRow } from './summarize'
import { foldTranscript, type TranscriptItem } from './transcript'

export interface SessionSnapshot { seq: number; graph: Graph }
// patch may be EMPTY (adapters filter); summary is null only for since()'s synthetic catch-up
export interface SessionUpdate { seq: number; patch: GraphPatch; event: EventRecord | null; summary: LogRow | null }
export type Unsubscribe = () => void

// One chats-list entry: id always; name/dir resolve from the project's identity notes and are
// null until that project's session has been opened (foreign, never-viewed projects).
export interface ProjectEntry { id: string; name: string | null; dir: string | null }

// nodeDetail's model-node shape — exported so the page aliases it (page/api.ts's ModelDetailView)
// instead of re-spelling the fields by hand at the cast site, the same PlanStepView/PlanNoteView
// posture api.ts already states for the plan shapes.
export interface ModelDetail {
  ref: string
  tasks: Array<{ taskId: string; title: string; status: string; calls: number; usage: Usage }>
  totals: Usage
}

// The one live store every adapter (web server, future TUI) subscribes to. Transport-free:
// callers get snapshots, per-event patches, catch-up patches, and node detail — never SQL,
// never HTTP.
export interface ProjectSessions {
  projects(): Promise<ProjectEntry[]>
  // membership/name push: fires with the fresh, name-resolved list whenever it actually changed —
  // new chats appear in every adapter without a reload. Backed by the storage-level
  // watchProjectIds wake (the shared NOTIFY channel). Row-deleting operations emit no NOTIFY;
  // the adapter that performs them calls notifyProjectsChanged() afterwards.
  subscribeProjects(cb: (projects: ProjectEntry[]) => void): Promise<Unsubscribe>
  notifyProjectsChanged(): Promise<void>
  snapshot(projectId: string): Promise<SessionSnapshot>
  // fires on EVERY event: the patch may be empty, the summary/log row is always present —
  // graph adapters filter on the patch, feed adapters (log, chat, TUI) consume the summary
  subscribe(projectId: string, cb: (u: SessionUpdate) => void): Promise<Unsubscribe>
  // catch-up for resume: one cumulative patch from a client's seq to now (null when current)
  since(projectId: string, fromSeq: number): Promise<SessionUpdate | null>
  nodeDetail(projectId: string, nodeId: string): Promise<unknown | null>
  // event-sourced provider/model refs — [] until a discovery has been appended
  modelCatalog(projectId: string): Promise<string[]>
  // drop a cached session (after a purge): the next read refolds from the log. Live SSE
  // subscribers of the old session go silent — the initiating client re-attaches itself;
  // other tabs stay stale until their next reload.
  reset(projectId: string): Promise<void>
  transcript(projectId: string, taskId: string, stepId?: string): Promise<TranscriptItem[]>
  taskPlans(projectId: string, taskId: string): Promise<{
    versions: Plan[]
    approvedVersion: number | null
    // rendered for the approved (else latest) version — conversation cards + request view
    visual: { version: number; mermaid: string; waves: TodoWave[] } | null
  } | null>
  // grounded decomposition: the plan-note graph living in the task's plan memory scope,
  // plus its rendered mermaid (client bundles must not import the diagram deps' server chain)
  planNotes(projectId: string, taskId: string): Promise<{ notes: ReturnType<typeof foldPlanNotes>; mermaid: string | null }>
  log(projectId: string, opts?: { taskId?: string; limit?: number }): Promise<LogRow[]>
  close(): Promise<void>
}

interface Session {
  storage: Storage
  events: EventRecord[]
  acc: FoldAcc
  mem: MemoryFold
  graph: Graph
  seq: number
  subscribers: Set<(u: SessionUpdate) => void>
  unsubscribe: () => Promise<void>
}

export function createProjectSessions(opts: {
  url: string
  cwdProject?: { id: string; name: string; dir?: string }
  // feeds buildGraph heat — the graph server passes the project's memoryHalfLifeDays so heat
  // and store ranking share one decay rate
  halfLifeDays?: number
}): ProjectSessions {
  const sessions = new Map<string, Promise<Session>>()

  async function open(projectId: string): Promise<Session> {
    const storage = await openStorage(opts.url, { projectId })
    const events = await storage.events.all()
    const acc = events.reduce(foldInto, emptyFold())
    const mem = events.reduce(foldMemoryInto, emptyMemoryFold())
    const session: Session = {
      storage, events, acc, mem,
      graph: buildGraph(acc.state, mem, { halfLifeDays: opts.halfLifeDays }),
      seq: events.at(-1)?.seq ?? 0,
      subscribers: new Set(),
      unsubscribe: async () => {},
    }
    // ponytail: refold-per-event is O(events) per event — swap in an incremental kernel
    // applyEvent behind this same interface when a log gets big
    // The cached log is append-only in memory, but the real one can be TRUNCATED out of band —
    // `orc purge`, deleting a chat — and no event announces that. Without this the server keeps
    // folding deleted history: the UI shows tasks and notes that no longer exist, and cannot
    // recover until the process restarts. One indexed lookup per event, against the oldest row we
    // still believe in; when it is gone, the cache is rebuilt from the log and the diff removes
    // the ghosts like any other change.
    const reload = async (): Promise<void> => {
      session.events = await storage.events.all()
      session.acc = session.events.reduce(foldInto, emptyFold())
      session.mem = session.events.reduce(foldMemoryInto, emptyMemoryFold())
      session.graph = buildGraph(session.acc.state, session.mem, { halfLifeDays: opts.halfLifeDays })
      session.seq = session.events.at(-1)?.seq ?? 0
    }
    // The truncation check below needs an event to arrive; a re-created log never delivers one
    // (our cursor sits above every new row), so the log reports it here instead.
    const onReset = async (): Promise<void> => {
      const stale = session.graph
      await reload()
      const repair = diffGraphs(stale, session.graph)
      for (const cb of session.subscribers) cb({ seq: session.seq, patch: repair, event: null, summary: null })
    }
    session.unsubscribe = await storage.events.subscribe({ fromSeq: session.seq, onReset }, async e => {
      const oldest = session.events[0]?.seq ?? 0
      if (oldest !== 0 && await storage.events.earliestSeq() !== oldest) {
        const stale = session.graph
        await reload()
        const repair = diffGraphs(stale, session.graph)
        for (const cb of session.subscribers) cb({ seq: session.seq, patch: repair, event: e, summary: summarizeEvent(e) })
        return
      }
      session.events.push(e)
      foldInto(session.acc, e)
      foldMemoryInto(session.mem, e)
      const next = buildGraph(session.acc.state, session.mem, { halfLifeDays: opts.halfLifeDays })
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
    if (!s) {
      s = open(projectId)
      sessions.set(projectId, s)
      // a failed open must not brick the project until restart — drop it so the next call retries
      s.catch(() => sessions.delete(projectId))
    }
    return s
  }

  // listed = has events. Purge keeps its project listed by re-seeding identity notes;
  // a DELETED project has zero events and correctly disappears — even the server's own.
  const listProjects = async (ids?: string[]): Promise<ProjectEntry[]> => {
    return Promise.all((ids ?? await listProjectIds(opts.url)).map(async id => {
      // notes (in already-open sessions) win over the cwd config values; unopened
      // foreign projects show a short id until first opened
      let name = id === opts.cwdProject?.id ? opts.cwdProject.name : null
      let dir = id === opts.cwdProject?.id ? opts.cwdProject.dir ?? null : null
      const cached = sessions.get(id)
      if (cached) {
        const s = await cached.catch(() => null)
        const live = s?.mem.notes
        const nameNote = live?.get(noteKey('project', PROJECT_NAME_NOTE_ID))
        if (nameNote) name = nameNote.note.title
        const dirNote = live?.get(noteKey('project', PROJECT_DIR_NOTE_ID))
        if (dirNote) dir = dirNote.note.title
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
      const patch = diffGraphs(buildGraph(fold(past), foldMemory(past), { halfLifeDays: opts.halfLifeDays }), s.graph)
      return emptyPatch(patch) ? null : { seq: s.seq, patch, event: null, summary: null }
    },

    async nodeDetail(projectId, nodeId) {
      const s = await sessionFor(projectId)
      if (nodeId.startsWith(NODE_PREFIX.step)) {
        const [, taskId, stepId] = nodeId.split(':')
        if (!taskId || !stepId) return null
        const plans = s.acc.state.plans.get(taskId)
        const plan = plans?.approvedVersion != null ? plans.versions.find(v => v.version === plans.approvedVersion) : undefined
        const step = plan?.steps.find(st => st.id === stepId)
        if (!step) return null
        return { step, run: s.acc.state.steps.get(taskId)?.get(stepId) ?? null }
      }
      if (nodeId.startsWith(NODE_PREFIX.artifact)) {
        const [, taskId, ...pathParts] = nodeId.split(':')
        const path = pathParts.join(':') // artifact paths may contain ':'
        return (s.acc.state.artifacts.get(taskId ?? '') ?? []).find(a => a.path === path) ?? null
      }
      if (nodeId.startsWith(NODE_PREFIX.model)) {
        // performance lens: every task this model took over, with per-model usage summed from
        // the agent_call events of exactly the steps that ran on it
        const ref = nodeId.slice(NODE_PREFIX.model.length)

        const tasks: ModelDetail['tasks'] = []
        for (const t of s.acc.state.tasks.values()) {
          const tp = s.acc.state.plans.get(t.id)
          const plan = tp?.approvedVersion != null ? tp.versions.find(v => v.version === tp.approvedVersion) : undefined
          const stepIds = new Set((plan?.steps ?? []).filter(st => st.modelRef === ref).map(st => st.id))
          if (stepIds.size === 0) continue
          let usage: Usage = ZERO_USAGE
          let calls = 0
          for (const e of s.events) {
            if (e.kind !== EVENT_KIND.agent_call || e.taskId !== t.id || !e.stepId || !stepIds.has(e.stepId) || !e.usage) continue
            usage = addUsage(usage, e.usage)
            calls++
          }
          tasks.push({ taskId: t.id, title: t.title, status: t.status, calls, usage })
        }
        if (tasks.length === 0) return null
        const detail: ModelDetail = { ref, tasks, totals: tasks.reduce((acc, t) => addUsage(acc, t.usage), ZERO_USAGE) }
        return detail
      }
      if (nodeId.startsWith(NODE_PREFIX.note)) {
        const key = nodeId.slice(NODE_PREFIX.note.length) // `${scope}\u0000${id}`
        const live = s.mem.notes
        const payload = live.get(key)
        if (!payload) return null
        const [scope, id] = key.split('\u0000')
        const hits = s.mem.access.get(key)?.hits ?? 0
        // backlinks: notes whose links target this note (links resolve same-scope)
        const backlinks = [...live.values()]
          .filter(({ note }) => note.scope === scope && note.links.some(l => l.id === id))
          .map(({ note }) => ({ id: note.id, scope: note.scope, title: note.title, kind: noteLabel(note) }))
        return { ...payload, hits, backlinks }
      }
      const task = s.acc.state.tasks.get(nodeId)
      if (!task) return null
      // artifacts dedup by (path, sha): a verify step re-declaring the same output is one
      // artifact, not two — the raw per-event list stays available on the artifact node itself
      const arts = new Map((s.acc.state.artifacts.get(nodeId) ?? []).map(a => [`${a.path}\u0000${a.sha256}`, a] as const))
      return {
        task,
        usage: taskUsage(s.acc.state, nodeId),
        steps: [...(s.acc.state.steps.get(nodeId)?.values() ?? [])].map(st => ({ ...st, usage: stepUsage(s.acc.state, nodeId, st.stepId) })),
        artifacts: [...arts.values()],
        // token-economy made visible: how often this task pulled knowledge instead of re-reading
        // (memory_accessed envelopes are task-bound since the store threads author identity)
        memoryPulls: s.events.filter(e => e.kind === EVENT_KIND.memory_accessed && e.taskId === nodeId).length,
      }
    },

    async transcript(projectId, taskId, stepId) {
      const s = await sessionFor(projectId)
      return foldTranscript(s.events, taskId, stepId)
    },

    async taskPlans(projectId, taskId) {
      const s = await sessionFor(projectId)
      const tp = s.acc.state.plans.get(taskId)
      if (!tp) return null
      const shown = (tp.approvedVersion != null ? tp.versions.find(v => v.version === tp.approvedVersion) : undefined) ?? tp.versions.at(-1)
      const runStates = s.acc.state.steps.get(taskId)
      // Once the plan is approved, every step is armed to run; a run-status entry (once a step
      // starts) always wins in statusClass. Fresh Map, so the raw run-status fold is never mutated.
      const approved = tp.approvedVersion != null
      const states = new Map<string, StepStatusEntry>()
      if (shown) for (const step of shown.steps) states.set(step.id, { approved })
      for (const [id, st] of runStates ?? []) states.set(id, { status: st.status, approved })
      return {
        versions: tp.versions,
        approvedVersion: tp.approvedVersion,
        visual: shown ? { version: shown.version, mermaid: planMermaid(shown.steps, states), waves: todoWaves(shown.steps, states) } : null,
      }
    },

    async planNotes(projectId, taskId) {
      const s = await sessionFor(projectId)
      const notes = foldPlanNotes(s.events, planScope(taskId))
      // Subplans execute as the CHILD's steps, which carry the note ids verbatim
      // (instantiateFrozenPlan) — so merging the children's step states is the whole correlation.
      // A child whose plan is approved (approvedVersion != null) but has not started any step yet
      // contributes an `approved` bit for every step id in its shown plan version, so the subplan
      // renders 'armed' between approval and first-step-start instead of an indistinguishable
      // pending. A child stuck at approvedVersion===null leaves all its step ids unmarked (pending).
      const substeps = new Map<string, StepStatusEntry>()
      for (const [childId, t] of s.acc.state.tasks) {
        if (t.parentId !== taskId) continue
        const cp = s.acc.state.plans.get(childId)
        const approved = cp != null && cp.approvedVersion != null
        if (approved) {
          const shown = cp.versions.find(v => v.version === cp.approvedVersion)
          for (const step of shown?.steps ?? []) substeps.set(step.id, { approved })
        }
        for (const [stepId, st] of s.acc.state.steps.get(childId) ?? []) substeps.set(stepId, { status: st.status, approved })
      }
      return { notes, mermaid: notes.length > 0 ? decompositionMermaid(notes, substeps) : null }
    },

    async modelCatalog(projectId) {
      const s = await sessionFor(projectId)
      return [...foldModelCatalog(s.events).entries()].flatMap(([pid, models]) => models.map(m => `${pid}/${m}`)).sort()
    },

    async reset(projectId) {
      const p = sessions.get(projectId)
      if (!p) return
      sessions.delete(projectId)
      const s = await p.catch(() => null)
      if (s) { await s.unsubscribe(); await s.storage.close() }
    },

    async log(projectId, opts = {}) {
      const s = await sessionFor(projectId)
      const limit = opts.limit ?? 200
      // Untargeted (opts.taskId undefined = whole-project Conversation view): every event,
      // unfiltered — slice then summarize, exactly as before. Task-scoped: summarize, then route
      // through shouldAdmitLogRow — the SAME predicate the live SSE tail (log.ts) uses — so a
      // project-scoped memory row is admitted only when payload.author.taskId matches the filter,
      // never blanket-admitted by null taskId. Filter must precede slice to return the last
      // `limit` MATCHING rows, not the last `limit` events of which few may match.
      const { taskId } = opts
      if (taskId === undefined) return s.events.slice(-limit).map(summarizeEvent)
      return s.events.map(summarizeEvent).filter(r => shouldAdmitLogRow(r, taskId)).slice(-limit)
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
