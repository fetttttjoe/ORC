import { describe, expect, it } from 'bun:test'
import { generateText, stepCountIs } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ToolSet } from 'ai'
import { authorFixture, eventFixture, listOf, must, planFixture, planNoteFixture, recordOf, taskFixture } from '@orc/contracts/fixtures'
import { DECISION_STATUS, Door, EVENT_KIND, ScopeType, TASK_STATUS, WORKSPACE_KIND, WORKSPACE_STATE, type EventRecord, type Origin, type PlanNote, type Workspace, type WorkspaceHealth, type WorkspaceWithHealth } from '@orc/contracts'
import type { OrcActions } from './actions'
import type { ProjectSessions } from './sessions'
import { modelOf } from './test-helpers'
import type { TranscriptItem } from './transcript'
import { asResolvedTools, buildCopilotTools, copilotSystemPrompt } from './copilot'
import type { CopilotFocus } from './copilot-focus'

// Honest stubs for the ui-core ports this suite drives: every member throws unless overridden,
// so an unexercised call surfaces loudly instead of a cast pretending the object is complete.
// ponytail: mirrors the e2e fixture's unsupported() helper; promote to a shared test-helper if a
// third suite needs it.
const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not available in this test`) }
const sessionsStub = (over: Partial<ProjectSessions> = {}): ProjectSessions => ({
  projects: unsupported('projects'), model: unsupported('model'), snapshot: unsupported('snapshot'), subscribe: unsupported('subscribe'),
  subscribeProjects: unsupported('subscribeProjects'), notifyProjectsChanged: unsupported('notifyProjectsChanged'),
  since: unsupported('since'), reset: unsupported('reset'), close: unsupported('close'), ...over,
})

// A stub feeds the read tools EVENTS, never a canned answer per tool: a tool can then only be
// handed a shape the fold itself can produce.
const sessionsOf = (events: EventRecord[], over: Partial<ProjectSessions> = {}): ProjectSessions =>
  sessionsStub({ model: async () => modelOf(events), ...over })
const actionsStub = (over: Partial<OrcActions> = {}): OrcActions => ({
  newTask: unsupported('newTask'), propose: unsupported('propose'), edit: unsupported('edit'),
  approve: unsupported('approve'), run: unsupported('run'), reply: unsupported('reply'),
  retry: unsupported('retry'), annotate: unsupported('annotate'), revise: unsupported('revise'),
  writeNote: unsupported('writeNote'), deleteNote: unsupported('deleteNote'),
  recordDecision: unsupported('recordDecision'),
  renameProject: unsupported('renameProject'), newProject: unsupported('newProject'),
  listWorkspaces: unsupported('listWorkspaces'), newWorkspace: unsupported('newWorkspace'),
  listModels: unsupported('listModels'),
  cancel: unsupported('cancel'), purgeProject: unsupported('purgeProject'), deleteProject: unsupported('deleteProject'), ...over,
})

// A full Workspace record, not a partial: the two workspace tools hand the record straight through,
// so a fixture missing a field would let the tools ship one too.
const wsFixture: Workspace = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Req', cwd: '/repo/.orc/worktrees/req',
  branch: 'orc/req', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
}
// …and the verdict that now travels with it. Full for the same reason: both doors pass `health`
// through untouched, so a partial here would let them ship a partial.
const healthFixture: WorkspaceHealth = {
  state: WORKSPACE_STATE.waiting, lastActivityAt: '2026-01-02T00:00:00.000Z',
  taskCount: 1, openTaskCount: 1, merged: false, provisionalNotes: 3, dirExists: true, clean: false,
}
const wsRow: WorkspaceWithHealth = { workspace: wsFixture, health: healthFixture }

// minimal scripted model (doGenerate shape verified in plugins/executor-api-loop/src/test-model.ts)
function scriptModel(turns: Array<{ text?: string; toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }>) {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[i++] ?? { text: '' }
      return {
        finishReason: { unified: (turn.toolCalls?.length ?? 0) > 0 ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        content: [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ...(turn.toolCalls ?? []).map(c => ({ type: 'tool-call' as const, toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) })),
        ],
        warnings: [],
      }
    },
  })
}

// An EMPTY log behind the read tools: no plan, no conversation, no decomposition, no activity —
// each answers its own "nothing yet", which is what the tools that do not exercise a fold need.
const stubSessions = sessionsOf([], {
  snapshot: async () => ({
    seq: 1,
    graph: { nodes: [{ id: 't1', type: 'task', label: 'build it', detail: 'draft' }], links: [] },
  }),
})

// The exchange these tools are built for. Every mutating tool passes it to the action it calls,
// so there is no origin-less spelling of buildCopilotTools to fall back to.
const ORIGIN: Origin = { chatId: 'chat-copilot', door: Door.mcp }
const author = authorFixture()
const wrotePlanNote = (seq: number, note: PlanNote): EventRecord =>
  eventFixture({ seq, taskId: null, kind: EVENT_KIND.memory_written, payload: { note, author } })

describe('copilot tools', () => {
  it('read tools ground the model; the loop runs tool → answer', async () => {
    const tools = buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN })
    const result = await generateText({
      model: scriptModel([
        { toolCalls: [{ toolCallId: 'c1', toolName: 'project_status', input: {} }] },
        { text: 'you have one draft task: build it' },
      ]),
      system: copilotSystemPrompt('test', 'read-only', undefined, null),
      messages: [{ role: 'user', content: 'what is going on?' }],
      tools,
      stopWhen: stepCountIs(3),
    })
    expect(result.text).toContain('one draft task')
    const toolResults = result.steps.flatMap(s => s.content.filter(c => c.type === 'tool-result'))
    expect(toolResults).toHaveLength(1)
    expect(JSON.stringify(toolResults[0])).toContain('build it')
  })

  it('asResolvedTools reshapes the copilot toolset for door #2: JSON schemas + {output,isError}', async () => {
    const tools = asResolvedTools(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN }))
    const status = must(tools.find(t => t.name === 'project_status'), 'tools.find(t => t.name === \'project_status\')')
    expect(status.inputSchema.type).toBe('object')
    expect(status.inputSchema.$schema).toBeUndefined() // stripped for MCP
    const r = await status.execute({}, undefined)
    expect(r.isError).toBe(false)
    expect(r.output).toHaveProperty('tasks')
  })

  it('project_status carries memory health when the probe is wired — a rebuilding read model must be visible at the door, not only in the DB', async () => {
    const health = async () => ({ memory: { state: 'catching_up' as const, pending: 372, reason: '372 event(s) not yet projected' } })
    const tools = asResolvedTools(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN, health }))
    const r = await must(tools.find(t => t.name === 'project_status'), 'tools.find(t => t.name === \'project_status\')').execute({}, undefined)
    expect(r.isError).toBe(false)
    expect(r.output).toHaveProperty('memory', { state: 'catching_up', pending: 372, reason: '372 event(s) not yet projected' })

    // probe absent → field omitted, never a fabricated "ok"
    const bare = asResolvedTools(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN }))
    const r2 = await must(bare.find(t => t.name === 'project_status'), 'bare.find(t => t.name === \'project_status\')').execute({}, undefined)
    expect(r2.output).not.toHaveProperty('memory')

    // probe failure → unreachable with the reason, mirroring graph-ui's /api/health posture
    const failing = asResolvedTools(buildCopilotTools({
      sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN,
      health: async () => { throw new Error('surreal is down') },
    }))
    const r3 = await must(failing.find(t => t.name === 'project_status'), 'failing.find(t => t.name === \'project_status\')').execute({}, undefined)
    expect(r3.isError).toBe(false)
    expect(r3.output).toHaveProperty('memory', { state: 'unreachable', pending: 0, reason: 'surreal is down' })
  })

  // `visual` is an ALLOWLIST, not a spread: the plans view serves a BROWSER as well, and a field
  // added there for a renderer must not silently start costing model tokens on every task_plan
  // call. It caught exactly that once — a mermaid diagram string, re-telling the model what
  // `waves` already says. So this pins the two keys a driver can act on, and nothing else.
  it('task_plan passes only the visual fields a driver can act on, dropping any other', async () => {
    const withPlan = sessionsOf([
      eventFixture({ seq: 1, taskId: 't1', kind: EVENT_KIND.task_created, payload: { task: taskFixture({ id: 't1' }) } }),
      eventFixture({ seq: 2, taskId: 't1', kind: EVENT_KIND.plan_proposed, payload: { plan: planFixture({ taskId: 't1' }) } }),
      eventFixture({ seq: 3, taskId: 't1', kind: EVENT_KIND.plan_approved, payload: { taskId: 't1', version: 1 } }),
    ])
    const tools = asResolvedTools(buildCopilotTools({ sessions: withPlan, actions: null, projectId: 'p1', origin: ORIGIN }))
    const r = await must(tools.find(t => t.name === 'task_plan'), 'tools.find(t => t.name === \'task_plan\')').execute({ taskId: 't1' }, undefined)
    expect(r.isError).toBe(false)
    expect(Object.keys(recordOf(recordOf(r.output).visual)).sort()).toEqual(['version', 'waves'])
    expect(JSON.stringify(r.output)).toContain('"waves"')
  })

  it('the human gate is structural: no approve tool even with actions wired', () => {
    const acting = buildCopilotTools({ sessions: stubSessions, actions: actionsStub(), projectId: 'p1', origin: ORIGIN })
    expect(Object.keys(acting)).toContain('run')
    expect(Object.keys(acting)).toContain('reply')
    expect(Object.keys(acting)).not.toContain('approve')
    expect(copilotSystemPrompt('proj', 'act', undefined, null)).toContain('HUMAN-ONLY')
  })

  it('available_models lists live refs and only exists when discovery is wired', async () => {
    const tools = buildCopilotTools({
      sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN,
      listModels: async () => ['anthropic/claude-x', 'ollama/llama3.2:3b'],
    })
    expect(Object.keys(tools)).toContain('available_models')
    expect(Object.keys(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN }))).not.toContain('available_models')
    const result = await generateText({
      model: scriptModel([
        { toolCalls: [{ toolCallId: 'c1', toolName: 'available_models', input: {} }] },
        { text: 'pick anthropic/claude-x' },
      ]),
      messages: [{ role: 'user', content: 'which models can I use?' }],
      tools,
      stopWhen: stepCountIs(3),
    })
    const toolResults = result.steps.flatMap(s => s.content.filter(c => c.type === 'tool-result'))
    expect(JSON.stringify(toolResults[0])).toContain('ollama/llama3.2:3b')
  })

  it('mutating tools call OrcActions; absent entirely without actions', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({
      newTask: async input => { calls.push(input); return { taskId: 't-new' } },
    })
    const tools = buildCopilotTools({ sessions: stubSessions, actions, projectId: 'p1', origin: ORIGIN })
    expect(Object.keys(tools)).toContain('new_request')
    expect(Object.keys(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN }))).not.toContain('new_request')

    const result = await generateText({
      model: scriptModel([
        { toolCalls: [{ toolCallId: 'c1', toolName: 'new_request', input: { title: 'demo request' } }] },
        { text: 'created t-new' },
      ]),
      messages: [{ role: 'user', content: 'make a request called demo request' }],
      tools,
      stopWhen: stepCountIs(3),
    })
    // budgetUSD travels explicitly: a chat tool never invents a spend cap, and the action requires one stated
    expect(calls).toEqual([{ title: 'demo request', budgetUSD: null }])
    expect(result.text).toContain('t-new')
  })
})

// Door #2 shape: call through asResolvedTools so the assertions run against the SAME
// safeParse-then-execute path an MCP client hits with raw JSON.
const callTool = async (tools: ToolSet, name: string, input: unknown) =>
  must(asResolvedTools(tools).find(t => t.name === name), 'asResolvedTools(tools).find(t => t.name === name)').execute(input, undefined)

// A step's conversation as the EVENTS it is folded from: a canned item list could assert a shape
// the fold can never produce.
const spoke = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord =>
  eventFixture({ seq, taskId: 't1', stepId: 's1', runToken: 'r1', kind, payload })
const calledTool = (seq: number, toolCallId: string, toolName: string, input: unknown): EventRecord =>
  spoke(seq, EVENT_KIND.tool_call, { stepId: 's1', iteration: 1, toolCallId, toolName, input })
const toolAnswered = (seq: number, toolCallId: string, output: unknown): EventRecord =>
  spoke(seq, EVENT_KIND.tool_result, { stepId: 's1', iteration: 1, toolCallId, toolName: 'fs_read', output, isError: false })

const QUESTION: Extract<TranscriptItem, { kind: 'question' }> = { kind: 'question', stepId: 's1', question: 'which cwd?'.repeat(80), answer: null }
const SIGNAL: Extract<TranscriptItem, { kind: 'signal' }> = { kind: 'signal', stepId: 's1', outcome: 'success', summary: 'done '.repeat(120) }

describe('workspaces at the doors', () => {
  it('workspace_new creates the workspace and its request task; workspace_list returns it', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({
      newWorkspace: async input => { calls.push(input); return { workspace: wsFixture, taskId: 't1' } },
      listWorkspaces: async () => [wsRow],
    })
    const tools = buildCopilotTools({ sessions: stubSessions, actions, projectId: 'p1', origin: ORIGIN })
    expect((await callTool(tools, 'workspace_new', { title: 'Req', spec: 'do it' })).output).toMatchObject({ taskId: 't1' })
    expect(calls).toEqual([{ title: 'Req', spec: 'do it' }])
    // the verdict travels WITH the record: a driver deciding where to work next needs to see that
    // this checkout is waiting on a person, not just that it exists
    expect((await callTool(tools, 'workspace_list', {})).output).toEqual([wsRow])
  })

  it('run no longer requires cwd — the kernel resolves the task\'s workspace', async () => {
    const seen: unknown[] = []
    const tools = buildCopilotTools({
      sessions: stubSessions, projectId: 'p1', origin: ORIGIN,
      actions: actionsStub({ run: async (id, cwd) => { seen.push([id, cwd]); return { requested: true, since: 1 } } }),
    })
    await callTool(tools, 'run', { taskId: 't1' })
    expect(seen).toEqual([['t1', null]])
  })

  it('new_request carries an explicit workspaceId through to the actions layer', async () => {
    const calls: unknown[] = []
    const tools = buildCopilotTools({
      sessions: stubSessions, projectId: 'p1', origin: ORIGIN,
      actions: actionsStub({ newTask: async input => { calls.push(input); return { taskId: 't9' } } }),
    })
    await callTool(tools, 'new_request', { title: 'in that worktree', workspaceId: wsFixture.id })
    expect(calls).toEqual([{ title: 'in that worktree', workspaceId: wsFixture.id, budgetUSD: null }])
  })

  // A driver's first question in a multi-workspace project is "which checkout is this task in?" —
  // project_status is where it starts, so the grouping lives there rather than behind a second tool.
  it('project_status groups the tasks it already lists under their workspaces', async () => {
    const sessions = sessionsStub({
      snapshot: async () => ({
        seq: 1,
        graph: {
          nodes: [
            { id: 't1', type: 'task', label: 'in the worktree', detail: 'draft', workspaceId: wsFixture.id },
            { id: 't2', type: 'task', label: 'somewhere else', detail: 'draft', workspaceId: 'another-workspace' },
          ],
          links: [],
        },
      }),
    })
    const tools = buildCopilotTools({ sessions, actions: null, projectId: 'p1', origin: ORIGIN, listWorkspaces: async () => [wsRow] })
    expect((await callTool(tools, 'project_status', {})).output).toMatchObject({
      workspaces: [{
        id: wsFixture.id, title: 'Req', kind: WORKSPACE_KIND.worktree, branch: 'orc/req',
        cwd: '/repo/.orc/worktrees/req', taskIds: ['t1'],
        // the SAME verdict workspace_list and `orc ws ls` carry — the tool a driver starts from
        // must not describe a checkout differently from the tool it moves on to
        health: healthFixture,
      }],
    })
    // no dep wired → the field is OMITTED. An empty array would read as "this project has no
    // workspaces", which is never true — every task has one.
    const bare = buildCopilotTools({ sessions, actions: null, projectId: 'p1', origin: ORIGIN })
    expect((await callTool(bare, 'project_status', {})).output).not.toHaveProperty('workspaces')
  })

  // Same posture the health probe already holds: project_status is the tool a driver starts from,
  // so an optional dep that fails must cost the caller that ONE field, never the whole answer.
  it('a failing listWorkspaces omits the field — it never takes project_status down', async () => {
    const tools = buildCopilotTools({
      sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN,
      listWorkspaces: async () => { throw new Error('the log is unreachable') },
    })
    const r = await callTool(tools, 'project_status', {})
    expect(r.isError).toBe(false)
    expect(r.output).toMatchObject({ tasks: [{ taskId: 't1', title: 'build it', status: 'draft' }] })
    expect(r.output).not.toHaveProperty('workspaces') // and never [], which reads as "none exist"
  })
})

// Knowledge authoring at the doors: the one WRITE a driver gets (memory_write stays filtered out of
// the MCP surface — see mcp-serve.test.ts). The tool owns no shape of its own: DecisionInput IS the
// inputSchema, so the refusal below happens at the door's parse, before actions is ever reached.
describe('decisions at the doors', () => {
  it('record_decision hands the parsed decision to actions and is absent without a mutating door', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({ recordDecision: async input => { calls.push(input); return { id: 'x', status: DECISION_STATUS.accepted, superseded: null } } })
    const tools = buildCopilotTools({ sessions: stubSessions, actions, projectId: 'p1', origin: ORIGIN })
    const r = await callTool(tools, 'record_decision', { title: 'X', context: 'c', decision: 'd', consequences: 'q' })
    expect(r.output).toEqual({ id: 'x', status: DECISION_STATUS.accepted, superseded: null })
    expect(calls).toEqual([{ title: 'X', context: 'c', decision: 'd', consequences: 'q', tags: [] }])
    // the door refuses a status the vocabulary does not have BEFORE actions sees it
    expect((await callTool(tools, 'record_decision', { title: 'X', context: 'c', decision: 'd', consequences: 'q', status: 'final' })).isError).toBe(true)
    expect(Object.keys(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', origin: ORIGIN }))).not.toContain('record_decision')
  })
})

// What the copilot is told about the selection. The block is rendered from the derived focus, so
// a copilot answering "this request" can never name a task the fold does not hold.
describe('the system prompt renders the selection', () => {
  const taskFocus: CopilotFocus = {
    type: ScopeType.task, title: 'wire the door', spec: 'the whole spec', status: TASK_STATUS.running,
    subtasks: [{ id: 't2', title: 'the child step', status: TASK_STATUS.draft }],
  }

  it('names the focus title (and its subtasks) when something is selected', () => {
    const prompt = copilotSystemPrompt('proj', 'act', undefined, taskFocus)
    expect(prompt).toContain('You are looking at')
    expect(prompt).toContain('wire the door')
    expect(prompt).toContain('the child step')
  })

  it('names a selected workspace and its requests', () => {
    const prompt = copilotSystemPrompt('proj', 'act', undefined, {
      type: ScopeType.workspace, title: 'Alpha', tasks: [{ id: 't1', title: 'build it', status: TASK_STATUS.draft }],
    })
    expect(prompt).toContain('You are looking at')
    expect(prompt).toContain('Alpha')
    expect(prompt).toContain('build it')
  })

  it('has NO focus block when nothing is selected', () => {
    expect(copilotSystemPrompt('proj', 'act', undefined, null)).not.toContain('You are looking at')
  })
})

describe('task_transcript (bounded for the MCP door)', () => {
  it('snips tool input/output to strings and leaves questions/signals verbatim', async () => {
    const tools = buildCopilotTools({
      sessions: sessionsOf([
        calledTool(1, 'c1', 'fs_read', { path: 'p'.repeat(600) }),
        toolAnswered(2, 'c1', { content: 'c'.repeat(900) }),
        spoke(3, EVENT_KIND.feedback_requested, { topic: 'cwd', question: QUESTION.question }),
        spoke(4, EVENT_KIND.signal_received, { stepId: 's1', signal: { outcome: SIGNAL.outcome, summary: SIGNAL.summary } }),
      ]),
      actions: null, projectId: 'p1', origin: ORIGIN,
    })
    const r = await callTool(tools, 'task_transcript', { taskId: 't1' })
    expect(r.isError).toBe(false)
    const out = listOf(r.output)
    const mappedTool = recordOf(out[0])
    expect(typeof mappedTool.input).toBe('string')
    expect(typeof mappedTool.output).toBe('string')
    expect(String(mappedTool.input).length).toBeLessThanOrEqual(401)
    expect(String(mappedTool.output).length).toBeLessThanOrEqual(401)
    // a driver must read a question and a signal EXACTLY — no snip, no reshape
    expect(out[1]).toEqual(QUESTION)
    expect(out[2]).toEqual(SIGNAL)
  })

  it('limit returns the LAST n items', async () => {
    const tools = buildCopilotTools({
      sessions: sessionsOf([1, 2, 3, 4, 5].map(i => calledTool(i, `c${i}`, `t${i}`, {}))),
      actions: null, projectId: 'p1', origin: ORIGIN,
    })
    const r = await callTool(tools, 'task_transcript', { taskId: 't1', limit: 2 })
    expect(listOf(r.output).map(i => recordOf(i).toolName)).toEqual(['t4', 't5'])
  })
})

describe('plan_notes (mechanical fields)', () => {
  it('carries dependsOn/zone/skillRefs/toolRefs/modelRef and a snipped body', async () => {
    const note = planNoteFixture({
      id: 'sub-a', title: 'Sub A', body: 'b'.repeat(900),
      dependsOn: ['generate-doc'], zone: ['docs/**'], skillRefs: ['role-auditor'], toolRefs: ['web/search'],
      modelRef: 'anthropic/claude-haiku-4-5',
    })
    const tools = buildCopilotTools({
      sessions: sessionsOf([wrotePlanNote(1, note)]), actions: null, projectId: 'p1', origin: ORIGIN,
    })
    const r = await callTool(tools, 'plan_notes', { taskId: 't1' })
    const out = recordOf(listOf(r.output)[0])
    expect(out).toMatchObject({
      id: 'sub-a', dependsOn: ['generate-doc'], zone: ['docs/**'],
      skillRefs: ['role-auditor'], toolRefs: ['web/search'], modelRef: 'anthropic/claude-haiku-4-5',
    })
    expect(typeof out.body).toBe('string')
    expect(String(out.body).length).toBeLessThanOrEqual(401)
  })

  it('omits modelRef entirely when the subplan inherits the parent model', async () => {
    const tools = buildCopilotTools({
      sessions: sessionsOf([wrotePlanNote(1, planNoteFixture({ modelRef: '' }))]),
      actions: null, projectId: 'p1', origin: ORIGIN,
    })
    const out = recordOf(listOf((await callTool(tools, 'plan_notes', { taskId: 't1' })).output)[0])
    expect(out).not.toHaveProperty('modelRef')
  })
})

describe('recent_activity (pollable)', () => {
  // five events across two steps and two kinds — enough that a cursor and a kind filter each have
  // something to leave out
  const feed = [
    spoke(5, EVENT_KIND.step_started, { stepId: 's1', attempt: 1 }),
    spoke(6, EVENT_KIND.tool_call, { stepId: 's1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} }),
    spoke(7, EVENT_KIND.step_started, { stepId: 's2', attempt: 1 }),
    spoke(9, EVENT_KIND.step_completed, { stepId: 's2', summary: 'done' }),
  ]
  const tools = buildCopilotTools({ sessions: sessionsOf(feed), actions: null, projectId: 'p1', origin: ORIGIN })

  const project = { type: ScopeType.project }

  it('returns { rows, maxSeq }, and the cursor and kind filter reach the read', async () => {
    const r = await callTool(tools, 'recent_activity', { scope: project, sinceSeq: 5, kinds: ['step_started', 'step_completed'], limit: 3 })
    // seq 5 is the caller's own cursor (EXCLUSIVE) and seq 6 is the wrong kind: a door that
    // dropped either filter would hand back rows the driver has already paid to read
    expect(r.output).toMatchObject({ maxSeq: 9 })
    expect(listOf(recordOf(r.output).rows).map(i => recordOf(i).seq)).toEqual([7, 9])
  })

  it('maxSeq is null when nothing is new', async () => {
    const r = await callTool(tools, 'recent_activity', { scope: project, sinceSeq: 9 })
    expect(r.output).toEqual({ rows: [], maxSeq: null })
  })

  it('rejects a kind that is not in the EventKind vocabulary', async () => {
    const r = await callTool(tools, 'recent_activity', { scope: project, kinds: ['not_a_kind'] })
    expect(r.isError).toBe(true)
  })

  // The scope is the view's own, so this door reads one conversation or one request without a
  // second filtering rule living here.
  it('narrows to a scope: a chat reads only its own rows, and an unstated scope is refused', async () => {
    const chatty = buildCopilotTools({ sessions: sessionsOf([...feed, eventFixture({ seq: 11, kind: EVENT_KIND.copilot_exchange, taskId: null, chatId: 'c1', door: Door.web, payload: { user: 'u', assistant: 'a', toolCalls: [], modelRef: 'm/m', taskId: null, workspaceId: null } })]), actions: null, projectId: 'p1', origin: ORIGIN })
    const r = await callTool(chatty, 'recent_activity', { scope: { type: ScopeType.chat, id: 'c1' } })
    expect(listOf(recordOf(r.output).rows).map(i => recordOf(i).seq)).toEqual([11])
    expect((await callTool(chatty, 'recent_activity', {})).isError).toBe(true)
  })
})
