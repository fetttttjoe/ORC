import { stepCountIs, streamText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { MEMORY_HEALTH, type MemoryHealth, type SupervisorHealth, errorMessage, isRecord, NoteAuthoringDraft, NoteRef, PlanDraft, type CopilotExchangePayload, type Usage } from '@orc/contracts'
import { VIEWS, buildCopilotTools, copilotSystemPrompt, createProjectSessions, emptyPatch, touchesOf, type CopilotMode, type OrcActions, type ProjectEntry, type ProjectSessions, type ReadModel, type SessionUpdate } from '@orc/ui-core'
import { PROJECT_PARAM, VIEW, VIEW_ROUTE, type OperatorState, type StreamFrame } from '@orc/ui-core/wire'
import path from 'node:path'
import { toolFailure } from './tool-failure'
import { viewResponse, type DoorAnswers } from './view-route'

export interface CopilotConfig {
  resolveModel: (ref: string) => LanguageModel // throws for unknown provider/model
  defaultModelRef: string
  listModels?: () => Promise<string[]> // live provider/model refs for pickers + the copilot
  // the project's workspaces WITH their health for the copilot's project_status — the same
  // door-neutral dep mcp-serve wires, so both doors answer "which checkout is this task in, and is
  // it still going anywhere?" the same way
  listWorkspaces?: Parameters<typeof buildCopilotTools>[0]['listWorkspaces']
  price?: (ref: string, usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }) => number | null
}

const CopilotBody = z.object({
  projectId: z.string().min(1),
  modelRef: z.string().min(1).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1).max(60),
})

// Every mutating route: its body schema and its dispatch, tied together in one closure so the
// parsed type flows into the handler with no casts — zod IS the validation and the typing.
// The web boundary is a trust boundary even on localhost.
// `project` is the chat the request came from (the x-orc-project header, defaulting to this
// server's own). Routes that act on ONE named project read it; the rest ignore it.
type ActionHandler = (a: OrcActions, body: unknown, project: string | undefined) => Promise<Response>

const route = <S extends z.ZodType>(schema: S, run: (a: OrcActions, input: z.output<S>, project: string | undefined) => Promise<unknown>): ActionHandler =>
  async (a, body, project) => {
    const parsed = schema.safeParse(body)
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
    return Response.json(await run(a, parsed.data, project))
  }

const id = z.string().min(1)
const ACTION_ROUTES: Record<string, ActionHandler> = {
  newTask: route(
    z.object({
      title: z.string().min(1), spec: z.string().optional(), parentId: id.optional(),
      grounded: z.object({ modelRef: id, cwd: id, analyzerRef: id.optional() }).optional(),
    }),
    (a, d) => a.newTask(d),
  ),
  propose: route(
    z.object({ taskId: id, modelRef: id, skillRefs: z.array(z.string()).optional() }),
    (a, d) => a.propose(d.taskId, { modelRef: d.modelRef, skillRefs: d.skillRefs }),
  ),
  // the draft is validated by the SAME contract schema the kernel writes with — no duplicate
  edit: route(z.object({ taskId: id, draft: PlanDraft }), (a, d) => a.edit(d.taskId, d.draft)),
  approve: route(
    z.object({ taskId: id, version: z.number().int().positive().optional() }),
    (a, d) => a.approve(d.taskId, d.version),
  ),
  run: route(z.object({ taskId: id, cwd: id }), (a, d) => a.run(d.taskId, d.cwd)),
  // answers the chat the user is LOOKING at, not this server's own project — a reply is a pure
  // append, so it belongs to whichever project asked the question (see CROSS_PROJECT_ACTIONS)
  reply: route(z.object({ taskId: id, text: z.string().min(1) }), (a, d, project) => a.reply(d.taskId, d.text, project)),
  retry: route(z.object({ taskId: id }), (a, d) => a.retry(d.taskId)),
  cancel: route(z.object({ taskId: id }), (a, d) => a.cancel(d.taskId)),
  annotate: route(
    z.object({ taskId: id, noteId: id, text: z.string().min(1), refs: z.array(z.string()).optional() }),
    (a, d) => a.annotate(d.taskId, d.noteId, d.text, d.refs),
  ),
  revise: route(
    z.object({ taskId: id, text: z.string().min(1), scope: z.array(id).min(1) }),
    (a, d) => a.revise(d.taskId, d.text, d.scope),
  ),
  writeNote: route(NoteAuthoringDraft, (a, d) => a.writeNote(d)),
  deleteNote: route(NoteRef, (a, d) => a.deleteNote(d.id, d.scope)),
  renameProject: route(z.object({ name: z.string().min(1).max(80) }), (a, d) => a.renameProject(d.name)),
  newProject: route(z.object({ dir: id, name: z.string().min(1).max(80) }), (a, d) => a.newProject(d.dir, d.name)),
  purgeProject: route(z.object({}), a => a.purgeProject()),
  deleteProject: route(z.object({ projectId: id }), (a, d) => a.deleteProject(d.projectId)),
}

// Actions that EXECUTE run against the ONE project this server was started in — they need the
// runtime that lives there (ensureRuntime's spawn, the DBOS port, the in-process zone write-fence),
// so from a foreign chat they would be a silent cross-project write and must die loudly here.
// ponytail: fence, not feature — per-project kernels/DBOS runtimes would lift it.
//
// These three name their own target project instead, and none of them executes anything:
// newProject touches no existing state, deleteProject targets an explicit FOREIGN project by design
// (the action refuses home), and `reply` is a pure append — the answer unblocks a parked step and
// the supervisor's router carries it in off feedback_provided. Fencing reply was a UX defect with no
// safety behind it: the sidebar lists and streams every project, so the pane showed a question and
// then refused to let the user answer it, sending them to a terminal for a row this server already
// had that project's log to write.
const CROSS_PROJECT_ACTIONS = new Set(['newProject', 'deleteProject', 'reply'])

// Thin web adapter: JSON + SSE over ProjectSessions. Nothing here knows how graphs are
// computed; a TUI adapter imports @orc/ui-core directly and never touches this file.
export interface GraphUiServer {
  port: number
  sessions: ProjectSessions
  token: string
  stop(): Promise<void>
}

export function startGraphUi(opts: {
  url: string
  port: number
  cwdProject?: { id: string; name: string; dir?: string }
  actions?: OrcActions // absent = read-only server (launched outside a project)
  copilot?: CopilotConfig
  defaultCwd?: string
  // degraded-state probe (memory read model, projector lag, supervisor liveness) — absent =
  // health unknown; supervisor absent = the composition has no storage to ask
  health?: () => Promise<{ memory: MemoryHealth; supervisor?: SupervisorHealth }>
  // P6 interaction journaling: append one copilot_exchange event per completed exchange — the
  // conversation that caused an action is part of the record. Absent = exchanges unrecorded.
  appendExchange?: (x: { payload: CopilotExchangePayload; usage: Usage | null }) => Promise<void>
  // threads config → sessions → graph heat: the same decay rate the store ranking uses
  memoryHalfLifeDays?: number
}): GraphUiServer {
  const sessions = createProjectSessions({ url: opts.url, cwdProject: opts.cwdProject, halfLifeDays: opts.memoryHalfLifeDays })
  // chats-list push: one sessions-level watch for the whole server, fanned out to every open
  // stream — a project born anywhere (CLI init, a bench run) reaches every sidebar live
  const projectFeeds = new Set<(ps: ProjectEntry[]) => void>()
  const projectsPush = sessions.subscribeProjects(ps => { for (const feed of projectFeeds) feed(ps) })
  // CSRF guard: minted per boot, readable only same-origin (GET /api/session), required as a
  // custom header on every mutation — cross-origin pages can neither read nor send it.
  const token = crypto.randomUUID()
  // shown in the page footer — makes a stale server process (old bundle, old routes) visible
  const bootedAt = new Date().toISOString()

  // The provider catalog a project has not discovered yet — see DoorAnswers.
  const whenEmpty: DoorAnswers = {
    [VIEW.models]: async () => await opts.copilot?.listModels?.() ?? [],
  }

  // the copilot loop: same tools as the UI, streamed to the client part by part — every tool
  // call is visible, usage is priced through the same table as agent runs
  const copilot = async (req: Request): Promise<Response> => {
    const cfg = opts.copilot
    if (!cfg) return Response.json({ error: 'copilot unavailable: start orc graph inside a project' }, { status: 501 })
    if (req.headers.get('x-orc-token') !== token) return Response.json({ error: 'missing or invalid x-orc-token' }, { status: 403 })
    const parsed = CopilotBody.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
    const { projectId, messages } = parsed.data
    const modelRef = parsed.data.modelRef ?? cfg.defaultModelRef
    let model: LanguageModel
    try { model = cfg.resolveModel(modelRef) } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 400 })
    }
    const home = projectId === opts.cwdProject?.id
    const name = home && opts.cwdProject ? opts.cwdProject.name : projectId.slice(0, 8)
    // same fence as /api/actions: the copilot may only mutate the project it runs in
    const mode: CopilotMode = opts.actions === undefined ? 'read-only' : home ? 'act' : 'foreign-project'
    const result = streamText({
      model,
      system: copilotSystemPrompt(name, mode, opts.defaultCwd),
      messages,
      tools: buildCopilotTools({
        sessions, actions: mode === 'act' ? opts.actions ?? null : null, projectId, listModels: cfg.listModels,
        // the same probe the footer badge polls (/api/health) — the copilot must see a
        // rebuilding read model too, or it narrates a silent project as healthy
        ...(opts.health && { health: opts.health }),
        // HOME project only. The dep reads the kernel this server was started with, while
        // `projectId` is whichever chat the user is looking at — wiring it unconditionally would
        // list this checkout's workspaces under a FOREIGN project's tasks, which is a wrong answer
        // rather than a missing one. listModels above needs no such fence: a provider catalog is
        // not project-scoped.
        ...(home && cfg.listWorkspaces && { listWorkspaces: cfg.listWorkspaces }),
      }),
      stopWhen: stepCountIs(8),
    })
    const enc = new TextEncoder()
    // the exchange record accumulates AS the stream flows — journaled once, after completion
    let assistant = ''
    const toolCalls: CopilotExchangePayload['toolCalls'] = []
    let exUsage: Usage | null = null
    const stream = new ReadableStream<Uint8Array>({
      start: async controller => {
        const send = (data: unknown): void => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
        try {
          for await (const part of result.fullStream) {
            switch (part.type) {
              case 'text-delta': send({ type: 'text', text: part.text }); assistant += part.text; break
              case 'tool-call':
                send({ type: 'tool-call', toolName: part.toolName, input: part.input })
                if (toolCalls.length < 64) toolCalls.push({ toolName: part.toolName, summary: (JSON.stringify(part.input) ?? '').slice(0, 140) })
                break
              case 'tool-result': send({ type: 'tool-result', toolName: part.toolName, output: part.output }); break
              case 'tool-error': send({ type: 'tool-error', toolName: part.toolName, error: String(part.error) }); break
              case 'error': send({ type: 'error', message: String(part.error) }); break
              case 'finish': {
                const usage = {
                  inputTokens: part.totalUsage.inputTokens ?? 0,
                  outputTokens: part.totalUsage.outputTokens ?? 0,
                  costUSD: cfg.price?.(modelRef, part.totalUsage) ?? null,
                }
                exUsage = { ...usage, estimated: false }
                send({ type: 'done', usage })
                break
              }
              default: break // start/step/reasoning parts are wire noise for us
            }
          }
        } catch (err) {
          send({ type: 'error', message: errorMessage(err) })
        } finally {
          // journal only the project this server can act in — a foreign-project chat is
          // read-only and its record belongs to that project's own server
          if (opts.appendExchange && home && (assistant !== '' || toolCalls.length > 0)) {
            const user = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
            await opts.appendExchange({ payload: { user, assistant, toolCalls, modelRef }, usage: exUsage })
              .catch(err => console.error('copilot exchange journaling failed:', err))
          }
          controller.close()
        }
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }

  const act = async (req: Request, name: string): Promise<Response> => {
    if (!opts.actions) return Response.json({ error: 'read-only server: start orc graph inside a project' }, { status: 501 })
    if (req.headers.get('x-orc-token') !== token) return Response.json({ error: 'missing or invalid x-orc-token' }, { status: 403 })
    const handler: ActionHandler | undefined = ACTION_ROUTES[name]
    if (!handler) return Response.json({ error: `unknown action '${name}'` }, { status: 404 })
    const claimed = req.headers.get('x-orc-project')
    if (claimed && opts.cwdProject && claimed !== opts.cwdProject.id && !CROSS_PROJECT_ACTIONS.has(name))
      return Response.json({
        error: `answering works from any chat, but running work does not: it happens in "${opts.cwdProject.name}" (where orc graph was started). Switch to that chat, or restart orc graph in this project's directory.`,
      }, { status: 409 })
    try {
      const body: unknown = await req.json().catch(() => null)
      const res = await handler(opts.actions, body, claimed ?? opts.cwdProject?.id)
      // purge/delete rewrote history behind a cached session — drop it so reads refold; both
      // change the chats list without an append NOTIFY (deletion removes rows outright), so
      // the push must be told explicitly
      if (res.ok && (name === 'purgeProject' || name === 'deleteProject')) {
        if (name === 'purgeProject' && opts.cwdProject) await sessions.reset(opts.cwdProject.id)
        if (name === 'deleteProject' && isRecord(body) && typeof body.projectId === 'string') await sessions.reset(body.projectId)
        await sessions.notifyProjectsChanged()
      }
      return res
    } catch (err) {
      // kernel throws are user-actionable (stale version, unknown task, no open feedback)
      return Response.json({ error: errorMessage(err) }, { status: 400 })
    }
  }

  const api = async (req: Request): Promise<Response> => {
    // Host-header allowlist: a DNS-rebinding page reaches this loopback server carrying its OWN
    // hostname in Host (attacker.com rebound to 127.0.0.1), so the browser treats it as same-origin
    // and BOTH the localhost bind and the CSRF token are defeated — it can read /api/session and
    // then drive run/deleteProject/copilot. Only a genuinely-loopback Host is the real UI.
    const hostname = (req.headers.get('host') ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1')
      return new Response('forbidden host', { status: 403 })
    const u = new URL(req.url)
    if (req.method === 'POST' && u.pathname === '/api/copilot') return copilot(req)
    if (req.method === 'POST' && u.pathname.startsWith('/api/actions/'))
      return act(req, u.pathname.slice('/api/actions/'.length))
    // `project` is an UNTRUSTED query param on unauthenticated GETs (/api/graph, /api/stream carry
    // no x-orc-token, and the Host allowlist checks Host, not Origin). It reaches sessionFor(),
    // which caches a session PERMANENTLY — a Postgres pool plus a dedicated LISTEN client — keyed by
    // whatever string arrived. So every distinct value leaked one of each, unbounded, from a request
    // anyone on the machine could make in a loop.
    //
    // Resolved against the projects that actually exist rather than pattern-matched: a well-formed
    // uuid for a project that was never created would allocate just as happily. One indexed query
    // against a set the UI already fetches, and an unknown id is treated as "no project" — every
    // consumer below already handles the empty string.
    const requested = u.searchParams.get(PROJECT_PARAM) ?? ''
    const project = requested !== '' && (await sessions.projects()).some(p => p.id === requested) ? requested : ''
    // Every read the browser can ask for, answered from the registry: the name is a path segment
    // and the params one url-encoded JSON value, both resolved by readView. A new question costs a
    // view and nothing here.
    if (u.pathname.startsWith(VIEW_ROUTE.prefix))
      return viewResponse(
        await sessions.model(project),
        u.pathname.slice(VIEW_ROUTE.prefix.length),
        u.searchParams.get(VIEW_ROUTE.params),
        whenEmpty,
      )
    switch (u.pathname) {
      case '/api/session':
        return Response.json({
          actions: opts.actions !== undefined,
          copilot: opts.copilot !== undefined,
          copilotModel: opts.copilot?.defaultModelRef ?? null,
          token,
          defaultCwd: opts.defaultCwd ?? null,
          // the ONE project this server can mutate — the page fences its buttons with it
          projectId: opts.cwdProject?.id ?? null,
          bootedAt,
        })
      case '/api/projects':
        return Response.json(await sessions.projects())
      case '/api/health':
        // never throws: a probe failure IS the degraded signal, not a 500
        return Response.json(opts.health
          ? await opts.health().catch(err => ({ memory: { state: MEMORY_HEALTH.unreachable, pending: 0, reason: errorMessage(err) } }))
          : { memory: null })
      case '/api/graph': {
        const s = await sessions.snapshot(project)
        return Response.json({ seq: s.seq, nodes: s.graph.nodes, links: s.graph.links })
      }
      case '/api/stream': {
        // resume point: Last-Event-ID (browser reconnect) wins over fromSeq (first attach)
        const lastEventId = req.headers.get('last-event-id')
        const fromSeq = Number(lastEventId ?? u.searchParams.get('fromSeq') ?? 0)
        let unsub: (() => void) | undefined
        let ping: ReturnType<typeof setInterval> | undefined
        let feed: ((ps: ProjectEntry[]) => void) | undefined
        const dropFeed = (): void => { if (feed) projectFeeds.delete(feed) }
        const stream = new ReadableStream<Uint8Array>({
          start: async controller => {
            const enc = new TextEncoder()
            const send = (seq: number, data: StreamFrame): void =>
              controller.enqueue(enc.encode(`id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`))
            // State sync rides the same stream WITHOUT an `id:` line: it describes no event, so it
            // must never advance the client's Last-Event-ID resume cursor.
            const sync = (data: StreamFrame): void => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
            controller.enqueue(enc.encode(': connected\n\n')) // flush headers + first byte immediately
            // keepalive: quiet projects emit nothing — periodic comments keep the connection
            // alive through idle timeouts and proxies, and detect dead clients (enqueue throws)
            ping = setInterval(() => {
              try { controller.enqueue(enc.encode(': ping\n\n')) } catch { clearInterval(ping); unsub?.(); dropFeed() }
            }, 25_000)
            // The operator value THIS connection last carried, serialized. Per connection, not per
            // server: a reconnecting tab holds none, and would otherwise wait for an event that
            // happened to change it before learning a task is parked on a question. Compared by
            // serialization because each fold builds the value afresh — no two share an identity,
            // and resending an unchanged one puts a full operator payload on the agent loop's
            // cadence.
            let lastOperator: string | null = null
            const operatorIfChanged = (model: ReadModel): OperatorState | null => {
              const value = VIEWS.operatorState.read(model, {})
              const key = JSON.stringify(value)
              if (key === lastOperator) return null
              lastOperator = key
              return value
            }
            // Subscribe FIRST (buffering), catch up second, flush third: an event landing
            // during the catch-up await is buffered, never lost. The old order (since → then
            // subscribe) left a gap the width of the awaits in between — luck-sized before,
            // structural zero now.
            let liveNow = false
            const buffered: SessionUpdate[] = []
            // Synchronous, and it takes no model of its own: `up.model` is the state as of
            // `up.seq`, handed over by the session inside the tick it notified in. Fetching one
            // back here would answer for whenever this happened to run — a frame describing a later
            // world than the seq it carries, with nothing failing to say so.
            const deliver = (up: SessionUpdate): void => {
              const patch = emptyPatch(up.patch) ? null : up.patch
              // A failed tool call rides ALONG the summary row rather than in a channel of its
              // own: the row already reaches every feed consumer, and the pane's question cards
              // are rendered from the same row — the reason an answer did not take has to land
              // next to the question that was re-asked, not somewhere else.
              const failure = toolFailure(up.event)
              const summary = up.summary && failure ? { ...up.summary, failure } : up.summary
              const touched = up.event ? touchesOf(up.event, up.model) : []
              try { send(up.seq, { patch, summary, touched, operator: operatorIfChanged(up.model) }) } catch { unsub?.(); dropFeed() }
            }
            unsub = await sessions.subscribe(project, up => {
              if (liveNow) deliver(up)
              else buffered.push(up)
            })
            const fromSafe = Number.isFinite(fromSeq) ? fromSeq : 0
            const missed = await sessions.since(project, fromSafe)
            // The first frame after connect always carries this connection's operator state: a tab
            // attaching to a quiet project must still know which tasks are waiting on a human, and
            // no event is owed for it. WHICH frame carries it is load-bearing — an id-less frame is
            // read against whatever Last-Event-ID the client still holds, and a client whose graph
            // has run ahead of that id reads it as a seq regression, drops the payload and resyncs,
            // on exactly the reconnect this value exists to serve. So it rides the catch-up frame,
            // which has an id, whenever there is one.
            if (missed) send(missed.seq, { patch: missed.patch, summary: null, operator: operatorIfChanged(missed.model) })
            else sync({ operator: operatorIfChanged(await sessions.model(project)) })
            const cutoff = missed?.seq ?? fromSafe
            for (const up of buffered) if (up.seq > cutoff) deliver(up)
            liveNow = true // sync flip before any yield — nothing can interleave
            // Seeded LAST: its await must not sit inside the event-delivery path.
            feed = ps => {
              try { sync({ projects: ps }) } catch { dropFeed() }
            }
            projectFeeds.add(feed)
            feed(await sessions.projects()) // seed: a (re)connecting tab converges without a reload
          },
          cancel: () => { clearInterval(ping); unsub?.(); dropFeed() },
        })
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        })
      }
      default:
        return new Response('not found', { status: 404 })
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    idleTimeout: 0, // SSE connections are idle by design — the default 10s would sever them
    development: process.env.ORC_GRAPH_DEV === '1',
    // the UI is the Vite-built SPA in web/dist (content-hashed assets); non-API paths fall back
    // to index.html so hash-router deep links survive a reload. `bun run build` in web/ rebuilds.
    fetch: async req => {
      const u = new URL(req.url)
      if (u.pathname.startsWith('/api')) return api(req)
      const dist = path.resolve(import.meta.dir, '../web/dist')
      const target = path.normalize(path.join(dist, u.pathname === '/' ? 'index.html' : u.pathname))
      if (target.startsWith(dist)) {
        const f = Bun.file(target)
        if (await f.exists()) return new Response(f)
      }
      const fallback = Bun.file(path.join(dist, 'index.html'))
      return (await fallback.exists())
        ? new Response(fallback)
        : new Response('ui not built — run `bun run build` in packages/graph-ui/web', { status: 503 })
    },
  })

  return {
    port: server.port ?? opts.port,
    sessions,
    token,
    stop: async () => {
      const unsubProjects = await projectsPush.catch(() => null)
      unsubProjects?.()
      await server.stop(true)
      await sessions.close()
    },
  }
}
