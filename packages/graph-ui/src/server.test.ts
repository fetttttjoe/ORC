import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { EVENT_KIND } from '@orc/contracts'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { MockLanguageModelV4 } from 'ai/test'
import { noteNodeId, type OrcActions } from '@orc/ui-core'
import { startGraphUi } from './server'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

const noteEvent = (id: string) => ({
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title: id }, author: { source: 'cli' as const } },
})

// Asserted subsets of the SSE stream contract (ui-core StreamEnvelope) — runtime-parsed
// because the test reads raw frames; shapes are named here, never cast at a call site.
const NodeRefView = z.object({ id: z.string() })
const AddNodesPatch = z.object({ addNodes: z.array(NodeRefView) })
const WriteSummary = z.object({ kind: z.string(), noteRef: z.string() })
const WriteEnvelope = z.object({ patch: AddNodesPatch, summary: WriteSummary })
const HeatNodeView = z.object({ id: z.string(), heat: z.number().optional() })
const HeatEnvelope = z.object({ patch: z.object({ updateNodes: z.array(HeatNodeView) }), summary: z.object({ line: z.string() }) })
const CatchUpEnvelope = z.object({ patch: AddNodesPatch })

// Asserted subsets of the JSON the web endpoints return — parsed at the read boundary so a
// contract drift fails the parse here instead of a cast silently lying about the shape.
const GraphView = z.object({ seq: z.number(), nodes: z.array(NodeRefView) })
const NodeDetailView = z.object({ task: z.object({ title: z.string() }) })
const SessionView = z.object({
  token: z.string(),
  actions: z.boolean(),
  copilot: z.boolean(),
  // null when the server has no cwdProject (read-only / project-free boots) — a bare `string`
  // cast here lied for every server started without one
  projectId: z.string().nullable(),
})
const ErrorView = z.object({ error: z.string() })
const ApproveResultView = z.object({ version: z.number() })
const PurgeResultView = z.object({ events: z.number() })
const TranscriptView = z.array(z.object({ text: z.string() }))

// A full OrcActions whose members throw unless overridden — the honest stub for route tests
// that drive only a verb or two (the e2e/server.ts `unsupported` precedent). Every member is
// present, so the value IS an OrcActions and needs no cast.
const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not stubbed in this test`) }
function stubActions(over: Partial<OrcActions>): OrcActions {
  return {
    newTask: unsupported('newTask'), propose: unsupported('propose'), edit: unsupported('edit'),
    approve: unsupported('approve'), run: unsupported('run'), reply: unsupported('reply'),
    retry: unsupported('retry'), annotate: unsupported('annotate'), revise: unsupported('revise'),
    writeNote: unsupported('writeNote'), deleteNote: unsupported('deleteNote'),
    renameProject: unsupported('renameProject'), newProject: unsupported('newProject'),
    cancel: unsupported('cancel'), purgeProject: unsupported('purgeProject'),
    deleteProject: unsupported('deleteProject'),
    ...over,
  }
}

async function setup() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  const t = await new Kernel(storage.events).createTask({ title: 'seed task', spec: '' })
  const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' } })
  const base = `http://127.0.0.1:${ui.port}`
  return { storage, taskId: t.id, ui, base }
}

// read SSE messages off a live stream until the predicate matches (2s cap)
async function readSse(res: Response, until: (msg: { id: number; data: string }) => boolean) {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 2000
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      for (const block of buf.split('\n\n').slice(0, -1)) {
        const id = Number(block.match(/^id: (\d+)$/m)?.[1] ?? -1)
        const data = block.match(/^data: (.*)$/m)?.[1] ?? ''
        const msg = { id, data }
        if (until(msg)) return msg
      }
    }
    return null
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('graph-ui web adapter', () => {
  it('serves projects, graph snapshot, node detail, and 404s', async () => {
    const { storage, taskId, ui, base } = await setup()
    expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([{ id: TEST_PROJECT_ID, name: 'test-proj', dir: null }])
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    expect(g.seq).toBeGreaterThan(0)
    expect(g.nodes.map(n => n.id)).toContain(taskId)
    const d = NodeDetailView.parse(await (await fetch(`${base}/api/node?project=${TEST_PROJECT_ID}&id=${taskId}`)).json())
    expect(d.task.title).toBe('seed task')
    expect((await fetch(`${base}/api/node?project=${TEST_PROJECT_ID}&id=nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/bogus`)).status).toBe(404)
    // DNS-rebinding defense: a request carrying a non-loopback Host is refused before routing
    expect((await fetch(`${base}/api/projects`, { headers: { host: 'evil.example.com' } })).status).toBe(403)
    await ui.stop(); await storage.close()
  })

  it('streams envelopes (patch + summary) and replays missed patches for a stale fromSeq', async () => {
    const { storage, ui, base } = await setup()
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())

    // live: open at the current seq, then append — the envelope must carry patch AND summary
    const live = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)
    const appended = await storage.events.append(noteEvent('live-note'))
    const liveMsg = await readSse(live, m => m.data.includes('live-note'))
    expect(liveMsg?.id).toBe(appended.seq)
    const env = WriteEnvelope.parse(JSON.parse(liveMsg!.data))
    expect(env.patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'live-note')])
    expect(env.summary.kind).toBe(EVENT_KIND.memory_written)
    expect(env.summary.noteRef).toBe(noteNodeId('project', 'live-note'))

    // a memory access is NOT graph-invisible since activation heat: the touched note re-patches
    // with heat > 0 (the "graph re-weights from use" contract), and the summary still streams
    const accessed = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${appended.seq}`)
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_accessed,
      payload: { id: 'live-note', scope: 'project', mode: 'read', author: { source: 'cli' } },
    })
    const heated = await readSse(accessed, m => m.data.includes('memory_accessed'))
    const heatedEnv = HeatEnvelope.parse(JSON.parse(heated!.data))
    const heatedNote = heatedEnv.patch.updateNodes.find(n => n.id === noteNodeId('project', 'live-note'))
    expect(heatedNote?.heat).toBeGreaterThan(0)
    expect(heatedEnv.summary.line).toContain('read')

    // resume: a NEW stream with the OLD fromSeq gets the note in its catch-up patch
    const resumed = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)
    const catchUp = await readSse(resumed, m => m.data.includes('live-note'))
    expect(catchUp).not.toBeNull()
    expect(CatchUpEnvelope.parse(JSON.parse(catchUp!.data)).patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'live-note')])

    await ui.stop(); await storage.close()
  })

  it('action routes: CSRF-guarded, 501 when read-only, dispatched with parsed input', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const calls: unknown[] = []
    const actions = stubActions({ approve: async (taskId: string, version?: number) => { calls.push([taskId, version]); return { version: version ?? 1 } } })
    const ui = startGraphUi({ url: db.url, port: 0, actions })
    const base = `http://127.0.0.1:${ui.port}`

    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    expect(session.actions).toBe(true)

    // no token -> 403, action not executed
    const forbidden = await fetch(`${base}/api/actions/approve`, { method: 'POST', body: JSON.stringify({ taskId: 't1' }) })
    expect(forbidden.status).toBe(403)
    expect(calls).toEqual([])

    // token + valid body -> dispatched
    const ok = await fetch(`${base}/api/actions/approve`, {
      method: 'POST', headers: { 'x-orc-token': session.token }, body: JSON.stringify({ taskId: 't1', version: 2 }),
    })
    expect(await ok.json()).toEqual({ version: 2 })
    expect(calls).toEqual([['t1', 2]])

    // bad body -> 400; unknown action -> 404
    expect((await fetch(`${base}/api/actions/approve`, { method: 'POST', headers: { 'x-orc-token': session.token }, body: '{}' })).status).toBe(400)
    expect((await fetch(`${base}/api/actions/nope`, { method: 'POST', headers: { 'x-orc-token': session.token }, body: '{}' })).status).toBe(404)
    await ui.stop()

    // read-only server (no actions) -> 501 regardless of token
    const ro = startGraphUi({ url: db.url, port: 0 })
    const roSession = SessionView.parse(await (await fetch(`http://127.0.0.1:${ro.port}/api/session`)).json())
    expect(roSession.actions).toBe(false)
    const blocked = await fetch(`http://127.0.0.1:${ro.port}/api/actions/approve`, {
      method: 'POST', headers: { 'x-orc-token': roSession.token }, body: JSON.stringify({ taskId: 't1' }),
    })
    expect(blocked.status).toBe(501)
    await ro.stop()
  })

  it('refuses cross-project mutations; newProject stays project-free', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const calls: string[] = []
    const actions = stubActions({
      approve: async (taskId: string) => { calls.push(`approve:${taskId}`); return { version: 1 } },
      newProject: async (dir: string, name: string) => { calls.push(`newProject:${name}`); return { projectId: 'p2', reused: false } },
      deleteProject: async (projectId: string) => { calls.push(`deleteProject:${projectId}`); return { events: 0, operations: 0, warnings: [] } },
    })
    const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'home' }, actions })
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    expect(session.projectId).toBe(TEST_PROJECT_ID)

    const post = (name: string, project: string, body: unknown) => fetch(`${base}/api/actions/${name}`, {
      method: 'POST',
      headers: { 'x-orc-token': session.token, 'x-orc-project': project },
      body: JSON.stringify(body),
    })

    // foreign chat → 409 with guidance, action NOT executed
    const blocked = await post('approve', 'some-other-project', { taskId: 't1' })
    expect(blocked.status).toBe(409)
    expect(ErrorView.parse(await blocked.json()).error).toContain('home')
    expect(calls).toEqual([])

    // home chat → dispatched; newProject/deleteProject allowed from ANY chat (project-free)
    expect(ApproveResultView.parse(await (await post('approve', TEST_PROJECT_ID, { taskId: 't1' })).json()).version).toBe(1)
    expect((await post('newProject', 'some-other-project', { dir: '/tmp', name: 'fresh' })).status).toBe(200)
    expect((await post('deleteProject', 'some-other-project', { projectId: 'doomed' })).status).toBe(200)
    expect(calls).toEqual(['approve:t1', 'newProject:fresh', 'deleteProject:doomed'])
    await ui.stop()
  })

  it('purgeProject resets the cached session — the next snapshot refolds from the empty log', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    await new Kernel(storage.events).createTask({ title: 'doomed', spec: '' })
    const actions = stubActions({
      purgeProject: async () => ({ ...(await storage.purge()), warnings: [] }),
    })
    const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'home' }, actions })
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())

    // session caches the task…
    const before = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    expect(before.nodes.length).toBeGreaterThan(0)

    const purged = await fetch(`${base}/api/actions/purgeProject`, {
      method: 'POST',
      headers: { 'x-orc-token': session.token, 'x-orc-project': TEST_PROJECT_ID },
      body: '{}',
    })
    expect(PurgeResultView.parse(await purged.json()).events).toBeGreaterThan(0)

    // …and after the purge the SAME endpoint serves the refolded (empty) world
    const after = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    expect(after.nodes).toEqual([])
    expect(after.seq).toBe(0)
    await ui.stop(); await storage.close()
  })

  it('copilot endpoint streams text + usage; guarded like actions', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    await new Kernel(storage.events).createTask({ title: 'seed', spec: '' })
    // provider-level scripted stream (shapes from @ai-sdk/provider LanguageModelV4StreamPart)
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] })
            c.enqueue({ type: 'text-start', id: '1' })
            c.enqueue({ type: 'text-delta', id: '1', delta: 'hello from copilot' })
            c.enqueue({ type: 'text-end', id: '1' })
            c.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 12, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 4, text: undefined, reasoning: undefined },
              },
            })
            c.close()
          },
        }),
      }),
    })
    const ui = startGraphUi({
      url: db.url, port: 0,
      copilot: { resolveModel: () => model, defaultModelRef: 'mock/m', price: () => 0.001 },
    })
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    expect(session.copilot).toBe(true)

    expect((await fetch(`${base}/api/copilot`, { method: 'POST', body: '{}' })).status).toBe(403)

    const res = await fetch(`${base}/api/copilot`, {
      method: 'POST', headers: { 'x-orc-token': session.token },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await res.text()
    expect(body).toContain('hello from copilot')
    expect(body).toContain('"type":"done"')
    expect(body).toContain('"costUSD":0.001')
    await ui.stop(); await storage.close()

    // no copilot config -> 501
    const ro = startGraphUi({ url: db.url, port: 0 })
    const roSession = SessionView.parse(await (await fetch(`http://127.0.0.1:${ro.port}/api/session`)).json())
    expect(roSession.copilot).toBe(false)
    expect((await fetch(`http://127.0.0.1:${ro.port}/api/copilot`, {
      method: 'POST', headers: { 'x-orc-token': roSession.token },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, messages: [{ role: 'user', content: 'hi' }] }),
    })).status).toBe(501)
    await ro.stop()
  })

  it('serves transcript, plans (404 when none), and limited log', async () => {
    const { storage, taskId, ui, base } = await setup()
    await storage.events.append({
      taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: { text: 'transcript line', toolCalls: [] } },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: null, estimated: false },
    })
    const items = TranscriptView.parse(await (await fetch(`${base}/api/transcript?project=${TEST_PROJECT_ID}&task=${taskId}`)).json())
    expect(items.map(i => i.text)).toEqual(['transcript line'])
    expect((await fetch(`${base}/api/plans?project=${TEST_PROJECT_ID}&task=${taskId}`)).status).toBe(404)
    expect(await (await fetch(`${base}/api/log?project=${TEST_PROJECT_ID}&limit=1`)).json()).toHaveLength(1)
    await ui.stop(); await storage.close()
  })
})
