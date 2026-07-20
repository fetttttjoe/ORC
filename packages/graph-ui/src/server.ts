import { z } from 'zod'
import { createProjectSessions, emptyPatch, type OrcActions, type ProjectSessions } from '@orc/ui-core'
import index from '../page/index.html'

// Every mutating route's body, by action name. Parsed before dispatch — the web boundary is a
// trust boundary even on localhost.
const ACTION_INPUT = {
  newTask: z.object({
    title: z.string().min(1), spec: z.string().optional(), parentId: z.string().optional(),
    grounded: z.object({ modelRef: z.string().min(1), cwd: z.string().min(1), analyzerRef: z.string().optional() }).optional(),
  }),
  propose: z.object({ taskId: z.string().min(1), modelRef: z.string().min(1), skillRefs: z.array(z.string()).optional() }),
  approve: z.object({ taskId: z.string().min(1), version: z.number().int().positive().optional() }),
  run: z.object({ taskId: z.string().min(1), cwd: z.string().min(1) }),
  reply: z.object({ taskId: z.string().min(1), text: z.string().min(1) }),
  retry: z.object({ taskId: z.string().min(1) }),
  cancel: z.object({ taskId: z.string().min(1) }),
} as const
type ActionName = keyof typeof ACTION_INPUT

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
  defaultCwd?: string
}): GraphUiServer {
  const sessions = createProjectSessions({ url: opts.url, cwdProject: opts.cwdProject })
  // CSRF guard: minted per boot, readable only same-origin (GET /api/session), required as a
  // custom header on every mutation — cross-origin pages can neither read nor send it.
  const token = crypto.randomUUID()

  const act = async (req: Request, name: string): Promise<Response> => {
    if (!opts.actions) return Response.json({ error: 'read-only server: start orc graph inside a project' }, { status: 501 })
    if (req.headers.get('x-orc-token') !== token) return Response.json({ error: 'missing or invalid x-orc-token' }, { status: 403 })
    if (!(name in ACTION_INPUT)) return Response.json({ error: `unknown action '${name}'` }, { status: 404 })
    const parsed = ACTION_INPUT[name as ActionName].safeParse(await req.json().catch(() => null))
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
    try {
      const a = opts.actions
      const p = parsed.data as never // narrowed per-case below
      switch (name as ActionName) {
        case 'newTask': return Response.json(await a.newTask(p))
        case 'propose': { const { taskId, ...rest } = parsed.data as z.infer<typeof ACTION_INPUT.propose>; return Response.json(await a.propose(taskId, rest)) }
        case 'approve': { const d = parsed.data as z.infer<typeof ACTION_INPUT.approve>; return Response.json(await a.approve(d.taskId, d.version)) }
        case 'run': { const d = parsed.data as z.infer<typeof ACTION_INPUT.run>; return Response.json(await a.run(d.taskId, d.cwd)) }
        case 'reply': { const d = parsed.data as z.infer<typeof ACTION_INPUT.reply>; return Response.json(await a.reply(d.taskId, d.text)) }
        case 'retry': { const d = parsed.data as z.infer<typeof ACTION_INPUT.retry>; return Response.json(await a.retry(d.taskId)) }
        case 'cancel': { const d = parsed.data as z.infer<typeof ACTION_INPUT.cancel>; return Response.json(await a.cancel(d.taskId)) }
      }
    } catch (err) {
      // kernel throws are user-actionable (stale version, unknown task, no open feedback)
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
    }
  }

  const api = async (req: Request): Promise<Response> => {
    const u = new URL(req.url)
    if (req.method === 'POST' && u.pathname.startsWith('/api/actions/'))
      return act(req, u.pathname.slice('/api/actions/'.length))
    const project = u.searchParams.get('project') ?? ''
    switch (u.pathname) {
      case '/api/session':
        return Response.json({ actions: opts.actions !== undefined, token, defaultCwd: opts.defaultCwd ?? null })
      case '/api/projects':
        return Response.json(await sessions.projects())
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
