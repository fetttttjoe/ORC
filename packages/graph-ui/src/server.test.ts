import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { AUTHOR_SOURCE, ChatKind, Door, EVENT_KIND, MEMORY_ACCESS, MessageRole, NO_CHAT, ScopeType, type EventInput } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, waitFor, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { MockLanguageModelV4 } from 'ai/test'
import { noteNodeId, type OrcActions } from '@orc/ui-core'
import { CopilotFrameType, CopilotPart, Envelope, LogRows, VIEW, ViewEnvelope, viewPath } from '@orc/ui-core/wire'
import { appendCopilotExchange } from './copilot-journal'
import { startGraphUi } from './server'

// the view route's URL comes from the wire's own builder — the format has one spelling, and this
// file asserts against the same one the browser will build with
const viewUrl = (base: string, project: string, name: string, params?: unknown): string =>
  base + viewPath(name, project, params)

// every read of the log names a scope; this is the widest one
const PROJECT_SCOPE = { type: ScopeType.project }

const dbs: Array<{ drop: () => Promise<void> }> = []
// Everything setup() opens is torn down HERE, before its database is dropped, whether or not the
// test remembered. startGraphUi holds an event stream AND a project watch, and a test that returned
// early left both alive against a database afterAll then dropped: measured on CI, one leaked server
// logged 116 reconnect failures into every LATER test file's output, burying the failures a reader
// is scanning for. Ordered — servers and storage first, databases last — because the reverse is
// exactly what produces the noise.
const openServers: Array<{ stop: () => void | Promise<void> }> = []
const openStores: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  for (const u of openServers) await Promise.resolve(u.stop()).catch(() => {})
  for (const st of openStores) await st.close().catch(() => {})
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

// The origins this suite speaks as: the operator seeding through the terminal, and the supervisor
// stamping what a running step produced.
const CLI = NO_CHAT(Door.cli)
const AGENT = NO_CHAT(Door.supervisor)

const noteEvent = (id: string): EventInput => ({
  ...CLI,
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title: id }, author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI } },
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
// the pane's feed row = ui-core's summary plus the failure this adapter lifts off the raw event
const FailureEnvelope = z.object({
  summary: z.object({ kind: z.string(), failure: z.object({ toolName: z.string(), error: z.string() }) }),
})

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
const framesOf = (body: string): CopilotPart[] =>
  body.split('\n').filter(l => l.startsWith('data: ')).map(l => CopilotPart.parse(JSON.parse(l.slice(6))))
const chatIdOf = (body: string): string | null => {
  for (const frame of framesOf(body)) if (frame.type === CopilotFrameType.chat) return frame.chatId
  return null
}
const ChatOpenedView = z.object({ chatId: z.string(), kind: z.string(), parent: z.null(), externalRef: z.null() })
const ExchangeView = z.object({ workspaceId: z.string().nullable() })

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
    recordDecision: unsupported('recordDecision'),
    renameProject: unsupported('renameProject'), newProject: unsupported('newProject'),
    listWorkspaces: unsupported('listWorkspaces'), newWorkspace: unsupported('newWorkspace'),
    listModels: unsupported('listModels'),
    cancel: unsupported('cancel'), purgeProject: unsupported('purgeProject'),
    deleteProject: unsupported('deleteProject'),
    ...over,
  }
}

async function setup() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  openStores.push(storage)
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(storage.events, CLI)
  const t = await new Kernel(storage.events).createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'seed task', spec: '' }, CLI)
  const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' } })
  openServers.push(ui)
  const base = `http://127.0.0.1:${ui.port}`
  return { storage, taskId: t.id, ui, base, url: db.url }
}

// Asserted subset of the chats-list push frames the stream carries alongside patches.
const ProjectsFrame = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string().nullable(), dir: z.string().nullable() })),
})

// read SSE messages off a live stream until the predicate matches (2s cap); `seen` observes
// every frame on the way — for asserting an earlier frame and a later one on ONE stream
// (a response body reader cannot be re-acquired after cancel)
async function readSse(res: Response, until: (msg: { id: number; data: string }) => boolean, seen?: (msg: { id: number; data: string }) => void) {
  const reader = must(res.body, 'sse response body').getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 2000
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      // Consume the complete blocks and KEEP only the partial tail. Re-splitting a growing buffer
      // replayed every earlier frame on each read, which `seen` then reported two and three times:
      // invisible to a `.some()`/`.find()` caller, fatal to one asserting the order frames arrived
      // in.
      const blocks = buf.split('\n\n')
      buf = blocks.pop() ?? ''
      for (const block of blocks) {
        const id = Number(block.match(/^id: (\d+)$/m)?.[1] ?? -1)
        const data = block.match(/^data: (.*)$/m)?.[1] ?? ''
        const msg = { id, data }
        seen?.(msg)
        if (until(msg)) return msg
      }
    }
    return null
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('graph-ui web adapter', () => {
  // `project` is an untrusted query param on an UNAUTHENTICATED GET, and it reached sessionFor(),
  // which caches a session permanently — a Postgres pool plus a dedicated LISTEN client — keyed by
  // whatever string arrived. Every distinct value leaked one of each, from a request anyone on the
  // machine could issue in a loop. Resolved against real projects now, so an unknown id is simply
  // "no project" rather than an allocation.
  it('an unknown ?project= is treated as no project, not opened as a session', async () => {
    const { base } = await setup()
    const res = await fetch(`${base}/api/graph?project=00000000-0000-4000-8000-00000000dead`)
    expect(res.status).toBe(200)
    const body = GraphView.parse(await res.json())
    // the home project's seeded task must NOT appear — an unknown id resolves to nothing
    expect(body.nodes.length).toBe(0)
  })

  it('serves projects, graph snapshot, node detail, and 404s', async () => {
    const { storage, taskId, ui, base } = await setup()
    expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([{ id: TEST_PROJECT_ID, name: 'test-proj', dir: null }])
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    expect(g.seq).toBeGreaterThan(0)
    expect(g.nodes.map(n => n.id)).toContain(taskId)
    const d = ViewEnvelope(NodeDetailView).parse(await (await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.node, { id: taskId }))).json())
    expect(d.data.task.title).toBe('seed task')
    // a node that does not exist is the view's own null, which the route answers 404 — not an
    // empty body a pane would render as a node with no fields
    expect((await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.node, { id: 'nope' }))).status).toBe(404)
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
    const env = WriteEnvelope.parse(JSON.parse(must(liveMsg, 'live envelope').data))
    expect(env.patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'live-note')])
    expect(env.summary.kind).toBe(EVENT_KIND.memory_written)
    expect(env.summary.noteRef).toBe(noteNodeId('project', 'live-note'))

    // a memory access is NOT graph-invisible since activation heat: the touched note re-patches
    // with heat > 0 (the "graph re-weights from use" contract), and the summary still streams
    const accessed = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${appended.seq}`)
    await storage.events.append({
      ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_accessed,
      payload: { id: 'live-note', scope: 'project', mode: MEMORY_ACCESS.read, author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI } },
    })
    const heated = await readSse(accessed, m => m.data.includes('memory_accessed'))
    const heatedEnv = HeatEnvelope.parse(JSON.parse(must(heated, 'heated envelope').data))
    const heatedNote = heatedEnv.patch.updateNodes.find(n => n.id === noteNodeId('project', 'live-note'))
    expect(heatedNote?.heat).toBeGreaterThan(0)
    expect(heatedEnv.summary.line).toContain('read')

    // resume: a NEW stream with the OLD fromSeq gets the note in its catch-up patch
    const resumed = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)
    const catchUp = await readSse(resumed, m => m.data.includes('live-note'))
    expect(catchUp).not.toBeNull()
    expect(CatchUpEnvelope.parse(JSON.parse(must(catchUp, 'catch-up envelope').data)).patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'live-note')])

    await ui.stop(); await storage.close()
  })

  // A broken approval gate rejected eight consecutive "approve" answers and the pane showed none
  // of it: the rejection was a tool_result, and the LogRow summary the pane consumes carries no
  // isError flag, so the only surface that knew was the log. This adapter has the raw event —
  // it lifts the failure onto the feed row so the pane can render the reason.
  it('a failed tool result rides the stream as a failure on the summary; a successful one does not', async () => {
    const { storage, taskId, ui, base } = await setup()
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)
    const toolResult = (toolCallId: string, isError: boolean, output: unknown): EventInput => ({
      ...AGENT, taskId, stepId: 'plan', runToken: 'r1', kind: EVENT_KIND.tool_result,
      payload: { stepId: 'plan', runToken: 'r1', iteration: 1, toolCallId, toolName: 'finalize_plan', output, isError },
    })
    await storage.events.append(toolResult('c1', false, 'plan frozen'))
    await storage.events.append(toolResult('c2', true, 'the plan graph changed since you approved'))

    const frames: string[] = []
    const failed = await readSse(stream, m => m.data.includes('"failure"'), m => frames.push(m.data))
    expect(failed).not.toBeNull()
    const env = FailureEnvelope.parse(JSON.parse(must(failed, 'failure envelope').data))
    expect(env.summary.kind).toBe(EVENT_KIND.tool_result)
    expect(env.summary.failure).toEqual({ toolName: 'finalize_plan', error: 'the plan graph changed since you approved' })
    // the successful result streamed first and carried no failure — errors are the signal, not
    // every tool result (the pane would drown)
    expect(frames.some(f => f.includes('plan frozen') && f.includes('"failure"'))).toBe(false)

    await ui.stop(); await storage.close()
  })

  // The frame says what changed, not just that something did: the queries this event made stale,
  // named by the registry that also answers the refetch. A client deciding that for itself needs a
  // table of event kinds, and the one that lived in the browser disagreed with the server silently
  // — a pane that simply stopped refreshing, with nothing to report.
  it('says what each event made stale, and pushes operator state only when it changed', async () => {
    const { storage, taskId, ui, base } = await setup()
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)

    await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'plan-gate', question: 'approve this plan?' },
    })
    await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.tool_call,
      payload: { stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
    })

    const frames: string[] = []
    const last = await readSse(stream, m => m.data.includes(EVENT_KIND.tool_call), m => frames.push(m.data))
    expect(last).not.toBeNull()

    const asked = Envelope.parse(JSON.parse(must(frames.find(f => f.includes(EVENT_KIND.feedback_requested)), 'the ask frame')))
    // the node the graph emitted for this task is stale — named by the registry, which is also
    // what answers the refetch, so the two cannot disagree
    expect(asked.touched).toContainEqual({ name: VIEW.node, params: { id: taskId } })
    expect(asked.operator?.openQuestions.map(q => q.question)).toEqual(['approve this plan?'])

    // …and the next event changed nothing an operator is waiting on, so the value is not resent:
    // it changes on almost every append, and a full payload per event would ride the agent loop's
    // cadence for a reading that did not move.
    const noise = Envelope.parse(JSON.parse(must(last, 'the tool-call frame').data))
    expect(noise.operator).toBeNull()
    // the timeline is stale in the SCOPES this event belongs to, not everywhere: a chat pane reading
    // another conversation holds a query no pattern here matches
    expect(noise.touched).toEqual([
      { name: VIEW.timeline, params: { scope: { type: ScopeType.project } } },
      { name: VIEW.timeline, params: { scope: { type: ScopeType.workspace, id: TEST_WORKSPACE_ID } } },
      { name: VIEW.timeline, params: { scope: { type: ScopeType.task, id: taskId, subtree: false } } },
      { name: VIEW.transcript, params: { taskId } },
    ])

    await ui.stop(); await storage.close()
  })

  // The invalidation half of the chat scope: a pane holding one chat's transcript is refetched by
  // that chat's traffic and by nothing else. A bare `[{}]` pattern put every pane on every other
  // chat's cadence — the agent loop's, in a project with a run going.
  it('names the chat scope of the event that carries one, and never another chat held query', async () => {
    const { storage, taskId, ui, base } = await setup()
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)
    const held = { name: VIEW.timeline, params: { scope: { type: ScopeType.chat, id: 'chat-held' } } }

    await storage.events.append({
      chatId: 'chat-held', door: Door.web, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.copilot_exchange,
      payload: { user: 'what is running?', assistant: 'the seed task', toolCalls: [], modelRef: 'mock/m', taskId: null, workspaceId: TEST_WORKSPACE_ID },
    })
    await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.tool_call,
      payload: { stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
    })

    const frames: string[] = []
    const last = await readSse(stream, m => m.data.includes(EVENT_KIND.tool_call), m => frames.push(m.data))
    const inChat = Envelope.parse(JSON.parse(must(frames.find(f => f.includes(EVENT_KIND.copilot_exchange)), 'the exchange frame')))
    expect(inChat.touched).toContainEqual(held)
    // the out-of-scope event: a step's tool call belongs to no chat, so the held query is current
    expect(Envelope.parse(JSON.parse(must(last, 'the tool-call frame').data)).touched).not.toContainEqual(held)

    await ui.stop(); await storage.close()
  })

  // Each frame answers for ITS OWN seq. The session hands the read model over with the notification
  // rather than letting a subscriber fetch one back, so a frame cannot describe a state later than
  // the event it announces — which is what a subscriber taking its own model across an await gets
  // the moment anything lets a second event land first.
  it('carries the state as of each frame own seq, in seq order', async () => {
    const { storage, taskId, ui, base } = await setup()
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)

    // back to back, so the answer is already folded while the question's frame is being written
    const asked = await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'plan-gate', question: 'approve this plan?' },
    })
    const answered = await storage.events.append({
      ...CLI, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'plan-gate', text: 'approve', author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI } },
    })

    const frames: Array<{ id: number; data: string }> = []
    await readSse(stream, m => m.data.includes(EVENT_KIND.feedback_provided), m => frames.push(m))
    const events = frames.filter(f => f.id > 0)
    expect(events.map(f => f.id)).toEqual([asked.seq, answered.seq])

    // one open question as of the ASK, none as of the ANSWER — the pair is the whole point: a
    // model taken late answers "none" for both, and the console never renders the gate at all
    expect(Envelope.parse(JSON.parse(must(events[0], 'the ask frame').data)).operator?.openQuestions).toHaveLength(1)
    expect(Envelope.parse(JSON.parse(must(events[1], 'the answer frame').data)).operator?.openQuestions).toHaveLength(0)

    await ui.stop(); await storage.close()
  })

  // A reconnecting tab holds no operator state and is owed no event: a project where the last
  // thing that happened was a question would otherwise read as idle until something else moved,
  // and "idle" is the one state that tells an operator to look elsewhere. With nothing missed there
  // is no frame to put it on, so it rides one of its own, id-less.
  it('tells a tab attaching AT the tip what is waiting on a human, on an id-less frame', async () => {
    const { storage, taskId, ui, base } = await setup()
    await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'plan-gate', question: 'approve this plan?' },
    })
    const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())

    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${g.seq}`)
    const seed = await readSse(stream, m => m.data.includes('openQuestions'))
    expect(seed).not.toBeNull()
    // state sync carries no SSE id: it describes no event, so it must never advance the client's
    // Last-Event-ID resume cursor
    expect(must(seed, 'operator seed').id).toBe(-1)
    const env = Envelope.parse(JSON.parse(must(seed, 'operator seed').data))
    expect(env.operator?.openQuestions.map(q => q.taskId)).toEqual([taskId])

    await ui.stop(); await storage.close()
  })

  // …but a tab attaching BEHIND the tip must get it on the catch-up frame, which has an id. An
  // id-less frame is read against whatever Last-Event-ID the client still holds, and a client whose
  // graph seq is ahead of that id treats the frame as a seq regression: it drops the payload and
  // resyncs — on exactly the reconnect this value exists to serve.
  it('gives a tab attaching BEHIND the tip its operator state on the catch-up frame, not on an id-less one', async () => {
    const { storage, taskId, ui, base } = await setup()
    const before = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
    await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { topic: 'plan-gate', question: 'approve this plan?' },
    })
    // a graph-visible event too, so the catch-up patch is non-empty and a catch-up frame exists
    const noted = await storage.events.append(noteEvent('catch-up-note'))
    // the session absorbs appends over LISTEN/NOTIFY — attach only once it is at the tip, or the
    // events arrive live and this tests the wrong path
    for (let i = 0; i < 40; i++) {
      const g = GraphView.parse(await (await fetch(`${base}/api/graph?project=${TEST_PROJECT_ID}`)).json())
      if (g.seq >= noted.seq) break
      await Bun.sleep(50)
    }

    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=${before.seq}`)
    const frames: Array<{ id: number; data: string }> = []
    const catchUp = await readSse(stream, m => m.data.includes('catch-up-note'), m => frames.push(m))
    expect(catchUp).not.toBeNull()
    expect(must(catchUp, 'catch-up frame').id).toBe(noted.seq)
    const env = Envelope.parse(JSON.parse(must(catchUp, 'catch-up frame').data))
    expect(env.operator?.openQuestions.map(q => q.taskId)).toEqual([taskId])
    // and nothing id-less carried it first, where the client could have discarded it
    expect(frames.slice(0, -1).some(f => f.id === -1 && f.data.includes('openQuestions'))).toBe(false)

    await ui.stop(); await storage.close()
  })

  it('pushes the chats list over the stream: seed on connect, update when a foreign project appears', async () => {
    const { storage, ui, base, url } = await setup()
    const stream = await fetch(`${base}/api/stream?project=${TEST_PROJECT_ID}&fromSeq=0`)

    // a FOREIGN project's first event (CLI init elsewhere, a bench run, …) must push the new
    // list to this already-open stream — the sidebar learns of chats this tab never touched
    const other = crypto.randomUUID()
    const foreign = await openStorage(url, { projectId: other })
    openStores.push(foreign)
    await foreign.events.append(noteEvent('foreign-born'))

    // one reader pass: collect every frame until the growth frame lands
    const frames: Array<{ id: number; data: string }> = []
    const grown = await readSse(stream, m => m.data.includes(other), m => frames.push(m))
    expect(grown).not.toBeNull()
    // projects frames carry NO SSE id: state sync must never advance Last-Event-ID resume
    expect(must(grown, 'grown').id).toBe(-1)
    expect(ProjectsFrame.parse(JSON.parse(must(grown, 'grown').data)).projects.map(p => p.id)).toContain(other)

    // the connect-time seed frame preceded it — reconnecting tabs converge without a reload
    const seed = frames.find(f => f.data.includes('"projects"'))
    expect(seed).not.toBeUndefined()
    expect(must(seed, 'seed').id).toBe(-1)
    expect(ProjectsFrame.parse(JSON.parse(must(seed, 'seed').data)).projects.map(p => p.id)).toContain(TEST_PROJECT_ID)

    await foreign.close(); await ui.stop(); await storage.close()
  })

  it('action routes: CSRF-guarded, 501 when read-only, dispatched with parsed input', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const calls: unknown[] = []
    const actions = stubActions({ approve: async (taskId, opts) => { calls.push([taskId, opts.version]); return { version: opts.version ?? 1 } } })
    const ui = startGraphUi({ url: db.url, port: 0, actions })
    openServers.push(ui)
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
    openServers.push(ro)
    const roSession = SessionView.parse(await (await fetch(`http://127.0.0.1:${ro.port}/api/session`)).json())
    expect(roSession.actions).toBe(false)
    const blocked = await fetch(`http://127.0.0.1:${ro.port}/api/actions/approve`, {
      method: 'POST', headers: { 'x-orc-token': roSession.token }, body: JSON.stringify({ taskId: 't1' }),
    })
    expect(blocked.status).toBe(501)
    await ro.stop()
  })

  // A click in the inspector comes from no copilot conversation, so /api/act stamps NO_CHAT — the
  // route used to read a chatId out of whatever body arrived, attributing an operator's action to
  // a chat nothing had said belonged to it.
  it('stamps an action with no chat even when its body carries one, and requires the budget key', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    openStores.push(storage)
    await seedTestWorkspace(storage.events, CLI)
    const kernel = new Kernel(storage.events)
    const actions = stubActions({
      newTask: async (input, origin) => ({ taskId: (await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: input.title, spec: '' }, origin)).id }),
    })
    const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'home' }, actions })
    openServers.push(ui)
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    const post = (body: unknown) => fetch(`${base}/api/actions/newTask`, {
      method: 'POST', headers: { 'x-orc-token': session.token }, body: JSON.stringify(body),
    })

    expect((await post({ title: 'from a click', budgetUSD: null, chatId: 'chat-nobody-claimed' })).status).toBe(200)
    const created = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.task_created)
    expect(created.map(e => [e.chatId, e.door])).toEqual([[null, Door.web]])

    // …and the ceiling is a required key, nullable value: an omitted one is refused rather than
    // quietly turned into "no budget" behind the caller's back
    expect((await post({ title: 'no ceiling stated' })).status).toBe(400)
    await ui.stop(); await storage.close()
  })

  it('refuses cross-project mutations; newProject and reply name their own project', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const calls: string[] = []
    const actions = stubActions({
      approve: async (taskId: string) => { calls.push(`approve:${taskId}`); return { version: 1 } },
      // the chat the request came from, NOT this server's own project — see CROSS_PROJECT_ACTIONS
      reply: async (taskId: string, text: string, projectId?: string) => {
        calls.push(`reply:${projectId}:${taskId}:${text}`)
        return { answered: true, supervised: false }
      },
      newProject: async (dir: string, name: string) => { calls.push(`newProject:${name}`); return { projectId: 'p2', reused: false } },
      deleteProject: async (projectId: string) => { calls.push(`deleteProject:${projectId}`); return { events: 0, operations: 0, warnings: [] } },
    })
    const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'home' }, actions })
    openServers.push(ui)
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

    // …but answering an open question is a pure append, so it is dispatched INTO the foreign chat.
    // The pane used to render the question and refuse to let the user answer it, sending them to a
    // terminal for a row this server already had that project's log to write.
    expect((await post('reply', 'some-other-project', { taskId: 't1', text: 'yes' })).status).toBe(200)

    // home chat → dispatched; newProject/deleteProject allowed from ANY chat (project-free)
    expect(ApproveResultView.parse(await (await post('approve', TEST_PROJECT_ID, { taskId: 't1' })).json()).version).toBe(1)
    expect((await post('newProject', 'some-other-project', { dir: '/tmp', name: 'fresh' })).status).toBe(200)
    expect((await post('deleteProject', 'some-other-project', { projectId: 'doomed' })).status).toBe(200)
    // …and the home chat's reply names the home project, so one action serves both
    expect((await post('reply', TEST_PROJECT_ID, { taskId: 't2', text: 'ok' })).status).toBe(200)
    expect(calls).toEqual([
      'reply:some-other-project:t1:yes', 'approve:t1', 'newProject:fresh', 'deleteProject:doomed',
      `reply:${TEST_PROJECT_ID}:t2:ok`,
    ])
    await ui.stop()
  })

  it('purgeProject resets the cached session — the next snapshot refolds from the empty log', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    openStores.push(storage)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(storage.events, CLI)
    await new Kernel(storage.events).createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'doomed', spec: '' }, CLI)
    const actions = stubActions({
      purgeProject: async () => ({ ...(await storage.purge()), warnings: [] }),
    })
    const ui = startGraphUi({ url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'home' }, actions })
    openServers.push(ui)
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
    openStores.push(storage)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(storage.events, CLI)
    await new Kernel(storage.events).createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'seed', spec: '' }, CLI)
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
    openServers.push(ui)
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    expect(session.copilot).toBe(true)

    expect((await fetch(`${base}/api/copilot`, { method: 'POST', body: '{}' })).status).toBe(403)

    const res = await fetch(`${base}/api/copilot`, {
      method: 'POST', headers: { 'x-orc-token': session.token },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, chatId: null, taskId: null, workspaceId: null, messages: [{ role: MessageRole.user, content: 'hi' }] }),
    })
    const frames = framesOf(await res.text())
    expect(frames.flatMap(f => f.type === CopilotFrameType.text ? [f.text] : []).join('')).toBe('hello from copilot')
    expect(frames.flatMap(f => f.type === CopilotFrameType.done ? [f.usage.costUSD] : [])).toEqual([0.001])
    await ui.stop(); await storage.close()

    // no copilot config -> 501
    const ro = startGraphUi({ url: db.url, port: 0 })
    openServers.push(ro)
    const roSession = SessionView.parse(await (await fetch(`http://127.0.0.1:${ro.port}/api/session`)).json())
    expect(roSession.copilot).toBe(false)
    expect((await fetch(`http://127.0.0.1:${ro.port}/api/copilot`, {
      method: 'POST', headers: { 'x-orc-token': roSession.token },
      body: JSON.stringify({ projectId: TEST_PROJECT_ID, chatId: null, taskId: null, workspaceId: null, messages: [{ role: MessageRole.user, content: 'hi' }] }),
    })).status).toBe(501)
    await ro.stop()
  })

  // A copilot conversation IS a chat: the first exchange opens one, every later exchange echoes
  // its id, and everything the exchange caused is stamped with it.
  it('copilot mints one chat: chat_opened + exchange together, an echoed id opens none, tools carry the chat', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    openStores.push(storage)
    await seedTestWorkspace(storage.events, CLI)
    const kernel = new Kernel(storage.events)
    const task = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'seed', spec: '' }, CLI)

    let turn = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const call = turn++ === 0 ? { toolCallId: 'c1', toolName: 'new_request', input: { title: 'from the chat' } } : null
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] })
              c.enqueue({ type: 'text-start', id: '1' })
              c.enqueue({ type: 'text-delta', id: '1', delta: 'on it' })
              c.enqueue({ type: 'text-end', id: '1' })
              if (call) c.enqueue({ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.stringify(call.input) })
              c.enqueue({
                type: 'finish',
                finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: undefined, reasoning: undefined },
                },
              })
              c.close()
            },
          }),
        }
      },
    })
    // the tool reaches the kernel through the action it was handed, so the origin the server built
    // is stamped on a real task_created — asserted on the log, not on a spy
    const actions = stubActions({
      newTask: async (input, origin) => {
        const t = await kernel.createTask({ workspaceId: input.workspaceId ?? TEST_WORKSPACE_ID, title: input.title, spec: input.spec ?? '' }, origin)
        return { taskId: t.id }
      },
    })
    const ui = startGraphUi({
      url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' }, actions,
      copilot: {
        resolveModel: () => model, defaultModelRef: 'mock/m',
        resolveWorkspace: async id => id === task.id ? TEST_WORKSPACE_ID : null,
      },
      // the composition root's seam, through the SAME function main.ts and the e2e fixture call
      appendExchange: async x => appendCopilotExchange(storage.events, x, Door.web),
    })
    openServers.push(ui)
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    const ask = async (chatId: string | null) => {
      const res = await fetch(`${base}/api/copilot`, {
        method: 'POST', headers: { 'x-orc-token': session.token },
        body: JSON.stringify({ projectId: TEST_PROJECT_ID, chatId, taskId: task.id, workspaceId: null, messages: [{ role: MessageRole.user, content: 'make one' }] }),
      })
      return must(chatIdOf(await res.text()), 'chat frame')
    }

    const chatId = await ask(null)
    const opens = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.chat_opened)
    expect(opens.map(e => [e.chatId, e.door])).toEqual([[chatId, Door.web]])
    expect(ChatOpenedView.parse(must(opens[0], 'chat_opened').payload)).toEqual({ chatId, kind: ChatKind.copilot, parent: null, externalRef: null })
    const firstExchange = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.copilot_exchange)
    expect(firstExchange.map(e => [e.chatId, e.door])).toEqual([[chatId, Door.web]])
    // no workspaceId in the body → the task's own workspace, not the process's guess
    expect(ExchangeView.parse(must(firstExchange[0], 'exchange').payload).workspaceId).toBe(TEST_WORKSPACE_ID)
    // the tool ran inside this exchange: its task_created names the same chat
    const created = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.task_created && e.chatId === chatId)
    expect(created.map(e => e.door)).toEqual([Door.web])

    // …and an exchange echoing the id opens nothing
    expect(await ask(chatId)).toBe(chatId)
    expect((await storage.events.all()).filter(e => e.kind === EVENT_KIND.chat_opened)).toHaveLength(1)
    expect((await storage.events.all()).filter(e => e.kind === EVENT_KIND.copilot_exchange)).toHaveLength(2)
    await ui.stop(); await storage.close()
  }, 20_000)

  // The id is published only once its chat is COMMITTED. Published from `finish` instead, the
  // client adopted an id for an append that was skipped or threw, echoed it on every later turn,
  // and the whole conversation lived in a chat with no chat_opened — which chatDigests drops, so
  // it left the chats view for good.
  it('publishes the chat id only when the exchange was journaled', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    openStores.push(storage)
    await seedTestWorkspace(storage.events, CLI)
    // a turn that says nothing and calls nothing is not an exchange — the server journals neither
    let silent = false
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] })
            if (!silent) {
              c.enqueue({ type: 'text-start', id: '1' })
              c.enqueue({ type: 'text-delta', id: '1', delta: 'on it' })
              c.enqueue({ type: 'text-end', id: '1' })
            }
            c.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: undefined, reasoning: undefined },
              },
            })
            c.close()
          },
        }),
      }),
    })
    let failing = false
    const appended: string[] = []
    const ui = startGraphUi({
      url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' },
      copilot: { resolveModel: () => model, defaultModelRef: 'mock/m' },
      appendExchange: async x => {
        if (failing) throw new Error('append refused')
        appended.push(x.chatId)
        await appendCopilotExchange(storage.events, x, Door.web)
      },
    })
    openServers.push(ui)
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    const ask = async (projectId: string): Promise<string> => {
      const res = await fetch(`${base}/api/copilot`, {
        method: 'POST', headers: { 'x-orc-token': session.token },
        body: JSON.stringify({ projectId, chatId: null, taskId: null, workspaceId: null, messages: [{ role: MessageRole.user, content: 'hi' }] }),
      })
      return await res.text()
    }

    // an exchange with content: the frame arrives, AFTER both events are in the log
    const done = await ask(TEST_PROJECT_ID)
    const chatId = must(chatIdOf(done), 'chat frame')
    expect(appended).toEqual([chatId])
    const order = framesOf(done).map(f => f.type)
    expect(order.indexOf(CopilotFrameType.chat)).toBeGreaterThan(order.indexOf(CopilotFrameType.done))
    expect((await storage.events.all()).filter(e => e.chatId === chatId).map(e => e.kind))
      .toEqual([EVENT_KIND.chat_opened, EVENT_KIND.copilot_exchange])

    // nothing said, nothing called → no append, so no id to adopt and no chat opened
    silent = true
    expect(chatIdOf(await ask(TEST_PROJECT_ID))).toBeNull()
    silent = false
    expect(appended).toHaveLength(1)

    // the append threw → the console keeps the error, the client learns no id
    failing = true
    expect(chatIdOf(await ask(TEST_PROJECT_ID))).toBeNull()
    failing = false

    // a foreign-project chat is read-only here: its record belongs to that project's own server,
    // so nothing is journaled and nothing is published
    expect(chatIdOf(await ask(crypto.randomUUID()))).toBeNull()
    expect((await storage.events.all()).filter(e => e.kind === EVENT_KIND.chat_opened)).toHaveLength(1)

    await ui.stop(); await storage.close()
  }, 20_000)

  it('journals the exchange when the client disconnects before the turn ends', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    openStores.push(storage)
    await seedTestWorkspace(storage.events, CLI)
    let hangUp = (): void => {}
    const disconnected = new Promise<void>(resolve => { hangUp = resolve })
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] })
            c.enqueue({ type: 'text-start', id: '1' })
            c.enqueue({ type: 'text-delta', id: '1', delta: 'on it' })
            c.enqueue({ type: 'text-end', id: '1' })
            await disconnected
            c.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: undefined, reasoning: undefined },
              },
            })
            c.close()
          },
        }),
      }),
    })
    const journaled: string[] = []
    const ui = startGraphUi({
      url: db.url, port: 0, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' },
      copilot: { resolveModel: () => model, defaultModelRef: 'mock/m' },
      appendExchange: async x => {
        await appendCopilotExchange(storage.events, x, Door.web)
        journaled.push(x.chatId)
      },
    })
    openServers.push(ui)
    const base = `http://127.0.0.1:${ui.port}`
    const session = SessionView.parse(await (await fetch(`${base}/api/session`)).json())
    const logged: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]): void => { logged.push(args.map(a => String(a)).join(' ')) }
    try {
      const abort = new AbortController()
      const res = await fetch(`${base}/api/copilot`, {
        method: 'POST', headers: { 'x-orc-token': session.token },
        body: JSON.stringify({ projectId: TEST_PROJECT_ID, chatId: null, taskId: null, workspaceId: null, messages: [{ role: MessageRole.user, content: 'hi' }] }),
        signal: abort.signal,
      })
      await must(res.body, 'stream body').getReader().read()
      abort.abort()
      hangUp()
      expect(await waitFor(async () => journaled.length === 1)).toBe(true)
    } finally {
      console.error = realError
    }
    const chatId = must(journaled[0], 'journaled chat')
    expect((await storage.events.all()).filter(e => e.chatId === chatId).map(e => e.kind))
      .toEqual([EVENT_KIND.chat_opened, EVENT_KIND.copilot_exchange])
    expect(logged).toEqual([])
    await ui.stop(); await storage.close()
  }, 20_000)

  it('serves transcript, plans (404 when none), and a limited timeline', async () => {
    const { storage, taskId, ui, base } = await setup()
    await storage.events.append({
      ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: { text: 'transcript line', toolCalls: [] } },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: null, estimated: false },
    })
    const items = ViewEnvelope(TranscriptView).parse(await (await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.transcript, { taskId }))).json())
    expect(items.data.map(i => i.text)).toEqual(['transcript line'])
    // a task nobody has planned has no plan — 404, where an empty versions list would read as a
    // task whose plan was emptied
    expect((await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.plans, { taskId }))).status).toBe(404)
    expect(ViewEnvelope(z.array(z.unknown())).parse(await (await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.timeline, { scope: PROJECT_SCOPE, limit: 1 }))).json()).data).toHaveLength(1)
    // a task scope answers REAL rows over HTTP, parsed as LogRows: the scope narrows the read
    // server-side, so a pane never filters a whole-project tail itself
    const scoped = ViewEnvelope(LogRows).parse(await (await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.timeline, { scope: { type: ScopeType.task, id: taskId, subtree: false } }))).json())
    expect(scoped.data.map(r => r.kind)).toContain(EVENT_KIND.agent_call)
    expect(scoped.data.every(r => r.taskId === taskId)).toBe(true)
    await ui.stop(); await storage.close()
  })

  // The filter is applied to the WHOLE log and the limit only afterwards. A read that sliced first
  // would answer this with nothing at all and still return 200 — a rare kind buried under a long
  // tail is exactly the row an operator goes looking for, so the content is pinned, not the status.
  it('answers a kind-filtered timeline out of a long tail, with the log tip as its seq', async () => {
    const { storage, taskId, ui, base } = await setup()
    const exchange = await storage.events.append({
      ...NO_CHAT(Door.web), taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.copilot_exchange,
      payload: { user: 'which task is blocked?', assistant: 'the seed task', toolCalls: [{ toolName: 'project_status', summary: '{}' }], modelRef: 'mock/m', taskId: null, workspaceId: null },
    })
    // one transaction: 450 round trips would dominate this file's runtime for a fact about filtering
    const tip = await storage.events.transaction(async tx => {
      let last = exchange
      for (let i = 1; i <= 450; i++) {
        last = await tx.append({
          ...AGENT, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.tool_call,
          payload: { stepId: 's1', runToken: 'r1', iteration: i, toolCallId: `c${i}`, toolName: 'fs_read', input: { i } },
        })
      }
      return last.seq
    })

    const res = await fetch(viewUrl(base, TEST_PROJECT_ID, VIEW.timeline, { scope: PROJECT_SCOPE, kinds: [EVENT_KIND.copilot_exchange], limit: 20 }))
    expect(res.status).toBe(200)
    const env = ViewEnvelope(LogRows).parse(await res.json())
    // the seq is the LOG TIP, not the matched row's: it is what a client orders its next refetch
    // against, so it has to say how current the answer is, not how old the newest match is
    expect(env.seq).toBe(tip)
    expect(env.data).toHaveLength(1)
    expect(env.data[0]?.seq).toBe(exchange.seq)
    // the whole exchange rides the row — the chat pane rebuilds its bubbles from the log
    expect(env.data[0]?.exchange?.assistant).toBe('the seed task')
    await ui.stop(); await storage.close()
    // 451 appends are 451 Postgres round trips even inside one transaction: 1.6s alone, and past
    // bun's 5s default once this file runs beside the rest of the suite.
  }, 30_000)
})
