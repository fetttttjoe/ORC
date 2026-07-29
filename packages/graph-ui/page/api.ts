import { type MemoryHealth, type Plan, type PlanNote, type PlanStep } from '@orc/contracts'
// The ONE http boundary of the page. Every request — reads, actions, streams — goes through
// here: URL building, token handling, JSON parsing, and the error policy live in this file and
// nowhere else. Consumers receive typed data or typed nulls; failures route through the
// configured onError exactly once.
import type { Graph, GraphNode, GraphLink, GraphPatch, LogRow, TodoWave, TranscriptItem } from '@orc/ui-core'
// type-only, so the browser bundle never pulls the server in: the shape is DECLARED where it is
// derived (src/tool-failure.ts) and read here, rather than spelled twice and drifting
import type { ToolFailure } from '../src/tool-failure'

// ---- response shapes (the API contract as the page sees it) ----
export interface Session {
  actions: boolean
  copilot: boolean
  copilotModel: string | null
  token: string
  defaultCwd: string | null
  projectId: string | null // the ONE project this server can mutate (null = read-only server)
  bootedAt: string // server boot time — the page shows it so a stale process is visible
}
export interface Project { id: string; name: string | null; dir: string | null }
export interface GraphSnapshot extends Graph { seq: number }
// The wire carries the contracts shapes verbatim (sessions.taskPlans serves Plan[]; planNotes
// serves PlanNote[]) — aliased under the page's View names, never re-spelled, so a contract
// field change reaches every consumer instead of drifting past a local copy (the ToolFailure
// precedent above).
export type PlanStepView = PlanStep
export type PlanNoteView = PlanNote
export interface PlansView {
  versions: Plan[]
  approvedVersion: number | null
  visual: { version: number; mermaid: string; waves: TodoWave[] } | null
}
export interface PlanNotesView { notes: PlanNoteView[]; mermaid: string | null }
// `projects` frames are membership/name pushes riding the same stream (no SSE id — they never
// advance the resume cursor); present only when the chats list actually changed, plus one seed
// frame on connect.
// The pane's feed row: ui-core's summary plus what this UI's server lifted off the raw event.
// `failure` is present only on the live stream — /api/log replays summaries alone, so a reload
// does not resurrect past error cards.
// ponytail: live-only is the whole gap; give LogRow an isError field if replayed failures matter.
export interface FeedRow extends LogRow { failure?: ToolFailure }
export interface StreamEnvelope { patch: GraphPatch | null; summary: FeedRow | null; projects?: Project[] }
export type CopilotPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'tool-result'; toolName: string; output: unknown }
  | { type: 'tool-error'; toolName: string; error: string }
  | { type: 'error'; message: string }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number; costUSD: number | null } }

export class ApiError extends Error {
  constructor(readonly endpoint: string, readonly status: number, message: string) {
    super(message)
  }
}

// ---- config: error policy injected once at boot (the api layer never imports UI) ----
interface ApiConfig { onError: (err: ApiError) => void }
let config: ApiConfig = { onError: () => {} }
export function initApi(c: ApiConfig): void { config = c }

export let session: Session = { actions: false, copilot: false, copilotModel: null, token: '', defaultCwd: null, projectId: null, bootedAt: '' }

// the chat the user is looking at — sent with every mutation so the server can refuse
// cross-project writes instead of silently landing them in its own project
let activeProject = ''
export function setApiProject(projectId: string): void { activeProject = projectId }
// Work RUNS in the server's own project chat only — the page fences those buttons with this, and
// the server enforces the same rule on x-orc-project. It is about execution: the runtime, the DBOS
// port and the in-process zone write-fence all live in the directory orc graph was started in.
export const canAct = (): boolean => session.actions && activeProject === session.projectId
// Answering is not execution. A reply is an append the server makes in whichever project asked the
// question, so what this UI can SEE it can answer — every chat in the sidebar, not just home. Only a
// server launched outside any project can write nothing at all, and only there does the affordance
// fall back to the CLI command. The old rule (home-only) meant the pane streamed a question live and
// then refused to let the user answer it, for a row the server already had that project's log to write.
export const canAnswer = (): boolean => session.actions && activeProject !== ''

// ---- plumbing ----
const query = (params: Record<string, string | number | undefined>): string => {
  const h = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) h.set(k, String(v))
  const s = h.toString()
  return s ? `?${s}` : ''
}

async function fail(endpoint: string, res: Response): Promise<never> {
  const body: unknown = await res.json().catch(() => null)
  const message = body !== null && typeof body === 'object' && 'error' in body ? String(body.error) : `HTTP ${res.status}`
  const err = new ApiError(endpoint, res.status, message)
  config.onError(err)
  throw err
}

// nullOn404: endpoints where "absent" is data, not an error
async function get<T>(endpoint: string, params: Record<string, string | number | undefined>, opts: { nullOn404?: boolean } = {}): Promise<T> {
  const res = await fetch(`/api/${endpoint}${query(params)}`)
  if (res.status === 404 && opts.nullOn404) return null as T
  if (!res.ok) return fail(endpoint, res)
  return res.json() as Promise<T>
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'x-orc-token': session.token, 'x-orc-project': activeProject, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return fail(endpoint, res)
  return res.json() as Promise<T>
}

// parse an SSE body stream, invoking onData per `data:` block until the stream ends
async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  if (!res.body) throw new Error(`${res.url}: response carried no body`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    const blocks = buf.split('\n\n')
    buf = blocks.pop() ?? ''
    for (const block of blocks) {
      const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('')
      if (data.trim()) onData(data)
    }
  }
}

// ---- the typed surface ----
export const api = {
  async initSession(): Promise<Session> {
    session = await get<Session>('session', {})
    return session
  },

  projects: () => get<Project[]>('projects', {}),
  // memory: null = server has no probe (launched outside a project) — render nothing
  health: () => get<{ memory: MemoryHealth | null }>('health', {}),
  models: (project?: string) => get<string[]>('models', { project }),
  graph: (project: string) => get<GraphSnapshot>('graph', { project }),
  node: (project: string, id: string) => get<unknown | null>('node', { project, id }, { nullOn404: true }),
  transcript: (project: string, task: string, step?: string) =>
    get<TranscriptItem[]>('transcript', { project, task, step }),
  plans: (project: string, task: string) => get<PlansView | null>('plans', { project, task }, { nullOn404: true }),
  planNotes: (project: string, task: string) => get<PlanNotesView>('plan-notes', { project, task }),
  log: (project: string, opts: { task?: string; limit?: number } = {}) =>
    get<LogRow[]>('log', { project, task: opts.task, limit: opts.limit }),

  act: <T = unknown>(name: string, body: unknown) => post<T>(`actions/${name}`, body),

  // copilot exchange: streams typed parts to the handler; resolves when the stream closes.
  // The signal aborts mid-stream (the server loop dies with the connection).
  async copilot(
    body: { projectId: string; modelRef?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> },
    onPart: (part: CopilotPart) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch('/api/copilot', {
      method: 'POST',
      headers: { 'x-orc-token': session.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) return fail('copilot', res)
    await readSse(res, data => onPart(JSON.parse(data) as CopilotPart))
  },

  // the live project stream (graph patches + event summaries), lossless resume built in
  eventStream(project: string, fromSeq: number, handlers: {
    onEnvelope: (env: StreamEnvelope, seq: number) => void
    onLive?: () => void
    onDown?: () => void
  }): { close: () => void } {
    const es = new EventSource(`/api/stream${query({ project, fromSeq })}`)
    es.onopen = () => handlers.onLive?.()
    es.onerror = () => handlers.onDown?.()
    es.onmessage = m => handlers.onEnvelope(JSON.parse(m.data) as StreamEnvelope, Number(m.lastEventId) || 0)
    return { close: () => es.close() }
  },
}

export type { Graph, GraphLink, GraphNode, GraphPatch, LogRow, ToolFailure, TodoWave, TranscriptItem }
