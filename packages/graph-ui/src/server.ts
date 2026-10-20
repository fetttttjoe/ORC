import { stepCountIs, streamText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { Door, KnowledgeHealthState, MessageRole, type KnowledgeHealth, NO_CHAT, type Origin, type SupervisorHealth, errorMessage, isRecord, PlanDraft, type CopilotExchangePayload, type Usage } from '@orc/contracts'
import { VIEWS, buildCopilotTools, copilotFocus, copilotSystemPrompt, createProjectSessions, emptyPatch, touchesOf, type CopilotMode, type OrcActions, type ProjectEntry, type ProjectSessions, type ReadModel, type SessionUpdate } from '@orc/ui-core'
import { CopilotFrameType, PROJECT_PARAM, VIEW, VIEW_ROUTE, type CopilotFrame, type OperatorState, type StreamFrame } from '@orc/ui-core/wire'
import path from 'node:path'
import { chatTitleOf, copilotChat } from './copilot-chat'
import type { CopilotExchangeRecord } from './copilot-journal'
import { toolFailure } from './tool-failure'
import { viewResponse, type DoorAnswers } from './view-route'

export interface CopilotConfig {
  resolveModel: (ref: string) => LanguageModel // throws for unknown provider/model
  defaultModelRef: string
  listModels?: () => Promise<string[]> // live provider/model refs for pickers + the copilot
  listWorkspaces?: Parameters<typeof buildCopilotTools>[0]['listWorkspaces']
  // The task's own workspace, else the one this server started in; this door holds no task index
  resolveWorkspace?: (taskId: string | null) => Promise<string | null>
  price?: (ref: string, usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }) => number | null
}

const CopilotBody = z.object({
  projectId: z.string().min(1),
  // Required, nullable: an optional key made a dropped id look like a new conversation
  chatId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  workspaceId: z.string().min(1).nullable(),
  modelRef: z.string().min(1).optional(),
  messages: z.array(z.object({ role: z.enum(MessageRole), content: z.string() })).min(1).max(60),
})

// project is the chat the request came from (x-orc-project, default this server's own)
type ActionHandler = (a: OrcActions, body: unknown, project: string | undefined, origin: Origin) => Promise<Response>

const route = <S extends z.ZodType>(schema: S, run: (a: OrcActions, input: z.output<S>, project: string | undefined, origin: Origin) => Promise<unknown>): ActionHandler =>
  async (a, body, project, origin) => {
    const parsed = schema.safeParse(body)
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
    return Response.json(await run(a, parsed.data, project, origin))
  }

const id = z.string().min(1)
const ACTION_ROUTES: Record<string, ActionHandler> = {
  newTask: route(
    z.object({
      title: z.string().min(1), spec: z.string().optional(), parentId: id.optional(),
      // required key, nullable value: a caller that forgot a ceiling is refused, not given none
      budgetUSD: z.number().positive().nullable(),
      grounded: z.object({ modelRef: id, cwd: id, analyzerRef: id.optional() }).optional(),
    }),
    (a, d, _p, o) => a.newTask(d, o),
  ),
  propose: route(
    z.object({ taskId: id, modelRef: id, skillRefs: z.array(z.string()).optional() }),
    (a, d, _p, o) => a.propose(d.taskId, { template: { modelRef: d.modelRef, skillRefs: d.skillRefs ?? [] } }, o),
  ),
  // the draft is validated by the SAME contract schema the kernel writes with — no duplicate
  edit: route(z.object({ taskId: id, draft: PlanDraft }), (a, d, _p, o) => a.edit(d.taskId, { draft: d.draft }, o)),
  approve: route(
    z.object({ taskId: id, version: z.number().int().positive().optional() }),
    (a, d, _p, o) => a.approve(d.taskId, { version: d.version }, o),
  ),
  run: route(z.object({ taskId: id, cwd: id }), (a, d, _p, o) => a.run(d.taskId, d.cwd, o)),
  // answers the chat the user is looking at: a reply is a pure append (see CROSS_PROJECT_ACTIONS)
  reply: route(z.object({ taskId: id, text: z.string().min(1) }), (a, d, project, o) => a.reply(d.taskId, d.text, project, o)),
  // no cwd: the retried run belongs in the task's own workspace, and this door has no terminal
  retry: route(z.object({ taskId: id }), (a, d, _p, o) => a.retry(d.taskId, null, o)),
  cancel: route(z.object({ taskId: id }), (a, d, _p, o) => a.cancel(d.taskId, o)),
  annotate: route(
    z.object({ taskId: id, noteId: id, text: z.string().min(1), refs: z.array(z.string()).optional() }),
    (a, d, _p, o) => a.annotate(d.taskId, d.noteId, d.text, d.refs ?? [], o),
  ),
  revise: route(
    z.object({ taskId: id, text: z.string().min(1), scope: z.array(id).min(1) }),
    (a, d, _p, o) => a.revise(d.taskId, d.text, d.scope, o),
  ),
  renameProject: route(z.object({ name: z.string().min(1).max(80) }), (a, d, _p, o) => a.renameProject(d.name, o)),
  newProject: route(z.object({ dir: id, name: z.string().min(1).max(80) }), (a, d, _p, o) => a.newProject(d.dir, d.name, o)),
  purgeProject: route(z.object({}), (a, _d, _p, o) => a.purgeProject(o)),
  deleteProject: route(z.object({ projectId: id }), (a, d, _p, o) => a.deleteProject(d.projectId, o)),
}

// fence, not feature: executing actions need the runtime that lives in the server's project
const CROSS_PROJECT_ACTIONS = new Set(['newProject', 'deleteProject', 'reply'])

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
  // absent = health unknown; supervisor absent = the composition has no storage to ask
  health?: () => Promise<{ knowledge: KnowledgeHealth; supervisor?: SupervisorHealth }>
  // One copilot_exchange event per completed exchange; absent means exchanges go unrecorded
  appendExchange?: (x: CopilotExchangeRecord) => Promise<void>
}): GraphUiServer {
  const sessions = createProjectSessions({ url: opts.url, cwdProject: opts.cwdProject })
  // One sessions-level watch fans the chats list out to every open stream
  const projectFeeds = new Set<(ps: ProjectEntry[]) => void>()
  const projectsPush = sessions.subscribeProjects(ps => { for (const feed of projectFeeds) feed(ps) })
  // CSRF guard: minted per boot, readable only same-origin, required as a header on mutations
  const token = crypto.randomUUID()
  // shown in the page footer — makes a stale server process (old bundle, old routes) visible
  const bootedAt = new Date().toISOString()

  // The provider catalog a project has not discovered yet — see DoorAnswers.
  const whenEmpty: DoorAnswers = {
    [VIEW.models]: async () => await opts.copilot?.listModels?.() ?? [],
  }

  const copilot = async (req: Request): Promise<Response> => {
    const cfg = opts.copilot
    if (!cfg) return Response.json({ error: 'copilot unavailable: start orc graph inside a project' }, { status: 501 })
    if (req.headers.get('x-orc-token') !== token) return Response.json({ error: 'missing or invalid x-orc-token' }, { status: 403 })
    const parsed = CopilotBody.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
    const { projectId, messages, taskId } = parsed.data
    const modelRef = parsed.data.modelRef ?? cfg.defaultModelRef
    const user = [...messages].reverse().find(m => m.role === MessageRole.user)?.content ?? ''
    const workspaceId = parsed.data.workspaceId ?? await cfg.resolveWorkspace?.(taskId) ?? null
    const chat = copilotChat({ chatId: parsed.data.chatId, taskId, workspaceId, title: chatTitleOf(user) }, () => crypto.randomUUID())
    const origin: Origin = { chatId: chat.chatId, door: Door.web }
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
      system: copilotSystemPrompt(name, mode, opts.defaultCwd, copilotFocus((await sessions.model(projectId)).state, { taskId, workspaceId })),
      messages,
      tools: buildCopilotTools({
        sessions, actions: mode === 'act' ? opts.actions ?? null : null, projectId, origin, listModels: cfg.listModels,
        ...(opts.health && { health: opts.health }),
        // Home project only: the dep reads this server's kernel, not the viewed project's
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
        const send = (data: CopilotFrame): void => {
          const frame = enc.encode(`data: ${JSON.stringify(data)}\n\n`)
          try { controller.enqueue(frame) } catch { /* client gone */ }
        }
        try {
          for await (const part of result.fullStream) {
            switch (part.type) {
              case 'text-delta': send({ type: CopilotFrameType.text, text: part.text }); assistant += part.text; break
              case 'tool-call':
                send({ type: CopilotFrameType.toolCall, toolName: part.toolName, input: part.input })
                if (toolCalls.length < 64) toolCalls.push({ toolName: part.toolName, summary: (JSON.stringify(part.input) ?? '').slice(0, 140) })
                break
              case 'tool-result': send({ type: CopilotFrameType.toolResult, toolName: part.toolName, output: part.output }); break
              case 'tool-error': send({ type: CopilotFrameType.toolError, toolName: part.toolName, error: String(part.error) }); break
              case 'error': send({ type: CopilotFrameType.error, message: String(part.error) }); break
              case 'finish': {
                const usage = {
                  inputTokens: part.totalUsage.inputTokens ?? 0,
                  outputTokens: part.totalUsage.outputTokens ?? 0,
                  costUSD: cfg.price?.(modelRef, part.totalUsage) ?? null,
                }
                exUsage = { ...usage, estimated: false }
                send({ type: CopilotFrameType.done, usage })
                break
              }
              default: break // start/step/reasoning parts are wire noise for us
            }
          }
        } catch (err) {
          send({ type: CopilotFrameType.error, message: errorMessage(err) })
        } finally {
          // journal only home: a foreign chat's record belongs to that project's own server
          if (opts.appendExchange && home && (assistant !== '' || toolCalls.length > 0)) {
            const journaled = await opts.appendExchange({
              chatId: chat.chatId, opened: chat.opened,
              payload: { user, assistant, toolCalls, modelRef, taskId, workspaceId }, usage: exUsage,
            }).then(() => true, (err: unknown) => {
              console.error('copilot exchange journaling failed:', err)
              return false
            })
            if (journaled) send({ type: CopilotFrameType.chat, chatId: chat.chatId })
          }
          try { controller.close() } catch { /* client gone */ }
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
      const res = await handler(opts.actions, body, claimed ?? opts.cwdProject?.id, NO_CHAT(Door.web))
      // purge and delete rewrite history without a NOTIFY: drop the session, push the list
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
    // Only a loopback Host is the real UI: a DNS-rebinding page defeats the bind and the CSRF token
    const hostname = (req.headers.get('host') ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1')
      return new Response('forbidden host', { status: 403 })
    const u = new URL(req.url)
    if (req.method === 'POST' && u.pathname === '/api/copilot') return copilot(req)
    if (req.method === 'POST' && u.pathname.startsWith('/api/actions/'))
      return act(req, u.pathname.slice('/api/actions/'.length))
    // Untrusted ?project=: resolve against existing projects so no session is allocated per value
    const requested = u.searchParams.get(PROJECT_PARAM) ?? ''
    const project = requested !== '' && (await sessions.projects()).some(p => p.id === requested) ? requested : ''
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
          ? await opts.health().catch(err => ({ knowledge: { state: KnowledgeHealthState.unavailable, reason: errorMessage(err) } }))
          : { knowledge: null })
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
            // No id: state sync describes no event, so it must not advance the resume cursor
            const sync = (data: StreamFrame): void => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
            controller.enqueue(enc.encode(': connected\n\n')) // flush headers + first byte immediately
            // keepalive comments hold idle connections open and detect dead clients
            ping = setInterval(() => {
              try { controller.enqueue(enc.encode(': ping\n\n')) } catch { clearInterval(ping); unsub?.(); dropFeed() }
            }, 25_000)
            // Per connection, not per server: a reconnecting tab holds none; compared by serialization
            let lastOperator: string | null = null
            const operatorIfChanged = (model: ReadModel): OperatorState | null => {
              const value = VIEWS.operatorState.read(model, {})
              const key = JSON.stringify(value)
              if (key === lastOperator) return null
              lastOperator = key
              return value
            }
            // Subscribe first (buffering), catch up second, flush third: no event is lost mid-catch-up
            let liveNow = false
            const buffered: SessionUpdate[] = []
            // deliver takes no model of its own: up.model is the state as of up.seq
            const deliver = (up: SessionUpdate): void => {
              const patch = emptyPatch(up.patch) ? null : up.patch
              // A failed tool call rides along the summary row, next to the question that was re-asked
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
            // Operator state rides the catch-up frame (has an id): an id-less frame can force a resync
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
    // Non-API paths fall back to index.html so hash-router deep links survive a reload
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
