import { stepCountIs, streamText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { PlanDraft } from '@orc/contracts'
import { buildCopilotTools, copilotSystemPrompt, createProjectSessions, emptyPatch, type OrcActions, type ProjectSessions } from '@orc/ui-core'
import index from '../page/index.html'

export interface CopilotConfig {
  resolveModel: (ref: string) => LanguageModel // throws for unknown provider/model
  defaultModelRef: string
  listModels?: () => Promise<string[]> // live provider/model refs for pickers + the copilot
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
type ActionHandler = (a: OrcActions, body: unknown) => Promise<Response>

const route = <S extends z.ZodType>(schema: S, run: (a: OrcActions, input: z.output<S>) => Promise<unknown>): ActionHandler =>
  async (a, body) => {
    const parsed = schema.safeParse(body)
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
    return Response.json(await run(a, parsed.data))
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
  reply: route(z.object({ taskId: id, text: z.string().min(1) }), (a, d) => a.reply(d.taskId, d.text)),
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
  renameProject: route(z.object({ name: z.string().min(1).max(80) }), (a, d) => a.renameProject(d.name)),
  newProject: route(z.object({ dir: id, name: z.string().min(1).max(80) }), (a, d) => a.newProject(d.dir, d.name)),
}

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
  cwdProject?: { id: string; name: string }
  actions?: OrcActions // absent = read-only server (launched outside a project)
  copilot?: CopilotConfig
  defaultCwd?: string
}): GraphUiServer {
  const sessions = createProjectSessions({ url: opts.url, cwdProject: opts.cwdProject })
  // CSRF guard: minted per boot, readable only same-origin (GET /api/session), required as a
  // custom header on every mutation — cross-origin pages can neither read nor send it.
  const token = crypto.randomUUID()

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
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
    }
    const name = projectId === opts.cwdProject?.id ? opts.cwdProject.name : projectId.slice(0, 8)
    const result = streamText({
      model,
      system: copilotSystemPrompt(name, opts.actions !== undefined),
      messages,
      tools: buildCopilotTools({ sessions, actions: opts.actions ?? null, projectId, listModels: cfg.listModels }),
      stopWhen: stepCountIs(8),
    })
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start: async controller => {
        const send = (data: unknown): void => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
        try {
          for await (const part of result.fullStream) {
            switch (part.type) {
              case 'text-delta': send({ type: 'text', text: part.text }); break
              case 'tool-call': send({ type: 'tool-call', toolName: part.toolName, input: part.input }); break
              case 'tool-result': send({ type: 'tool-result', toolName: part.toolName, output: part.output }); break
              case 'tool-error': send({ type: 'tool-error', toolName: part.toolName, error: String(part.error) }); break
              case 'error': send({ type: 'error', message: String(part.error) }); break
              case 'finish':
                send({
                  type: 'done',
                  usage: {
                    inputTokens: part.totalUsage.inputTokens ?? 0,
                    outputTokens: part.totalUsage.outputTokens ?? 0,
                    costUSD: cfg.price?.(modelRef, part.totalUsage) ?? null,
                  },
                })
                break
              default: break // start/step/reasoning parts are wire noise for us
            }
          }
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        } finally {
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
    try {
      return await handler(opts.actions, await req.json().catch(() => null))
    } catch (err) {
      // kernel throws are user-actionable (stale version, unknown task, no open feedback)
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
    }
  }

  const api = async (req: Request): Promise<Response> => {
    const u = new URL(req.url)
    if (req.method === 'POST' && u.pathname === '/api/copilot') return copilot(req)
    if (req.method === 'POST' && u.pathname.startsWith('/api/actions/'))
      return act(req, u.pathname.slice('/api/actions/'.length))
    const project = u.searchParams.get('project') ?? ''
    switch (u.pathname) {
      case '/api/session':
        return Response.json({
          actions: opts.actions !== undefined,
          copilot: opts.copilot !== undefined,
          copilotModel: opts.copilot?.defaultModelRef ?? null,
          token,
          defaultCwd: opts.defaultCwd ?? null,
        })
      case '/api/projects':
        return Response.json(await sessions.projects())
      case '/api/models':
        return Response.json(await opts.copilot?.listModels?.() ?? [])
      case '/api/graph': {
        const s = await sessions.snapshot(project)
        return Response.json({ seq: s.seq, nodes: s.graph.nodes, links: s.graph.links })
      }
      case '/api/node': {
        const d = await sessions.nodeDetail(project, u.searchParams.get('id') ?? '')
        return d === null ? new Response('not found', { status: 404 }) : Response.json(d)
      }
      case '/api/transcript':
        return Response.json(await sessions.transcript(project, u.searchParams.get('task') ?? '', u.searchParams.get('step') ?? undefined))
      case '/api/plans': {
        const p = await sessions.taskPlans(project, u.searchParams.get('task') ?? '')
        return p === null ? new Response('not found', { status: 404 }) : Response.json(p)
      }
      case '/api/plan-notes':
        return Response.json(await sessions.planNotes(project, u.searchParams.get('task') ?? ''))
      case '/api/log': {
        const limitRaw = Number(u.searchParams.get('limit'))
        return Response.json(await sessions.log(project, {
          taskId: u.searchParams.get('task') ?? undefined,
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
        }))
      }
      case '/api/stream': {
        // resume point: Last-Event-ID (browser reconnect) wins over fromSeq (first attach)
        const lastEventId = req.headers.get('last-event-id')
        const fromSeq = Number(lastEventId ?? u.searchParams.get('fromSeq') ?? 0)
        let unsub: (() => void) | undefined
        let ping: ReturnType<typeof setInterval> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start: async controller => {
            const enc = new TextEncoder()
            const send = (seq: number, data: unknown): void =>
              controller.enqueue(enc.encode(`id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`))
            controller.enqueue(enc.encode(': connected\n\n')) // flush headers + first byte immediately
            // keepalive: quiet projects emit nothing — periodic comments keep the connection
            // alive through idle timeouts and proxies, and detect dead clients (enqueue throws)
            ping = setInterval(() => {
              try { controller.enqueue(enc.encode(': ping\n\n')) } catch { clearInterval(ping); unsub?.() }
            }, 25_000)
            // catch-up first (one cumulative patch), then live — seq gaps are impossible
            // because the session serializes both through the same event subscription.
            // Envelope: { patch|null, summary|null } — patch feeds the graph, summary feeds
            // the log/chat views; empty patches are nulled to keep messages small.
            const missed = await sessions.since(project, Number.isFinite(fromSeq) ? fromSeq : 0)
            if (missed) send(missed.seq, { patch: missed.patch, summary: null })
            unsub = await sessions.subscribe(project, up => {
              const patch = emptyPatch(up.patch) ? null : up.patch
              try { send(up.seq, { patch, summary: up.summary }) } catch { unsub?.() }
            })
          },
          cancel: () => { clearInterval(ping); unsub?.() },
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
    // production by default: the page is bundled once at startup with content-hashed asset
    // URLs, so a reload can never serve a stale bundle. ORC_GRAPH_DEV=1 restores HMR.
    development: process.env.ORC_GRAPH_DEV === '1',
    routes: { '/': index },
    fetch: api,
  })

  return {
    port: server.port ?? opts.port,
    sessions,
    token,
    stop: async () => { await server.stop(true); await sessions.close() },
  }
}
