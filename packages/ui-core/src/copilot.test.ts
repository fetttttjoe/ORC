import { describe, expect, it } from 'bun:test'
import { generateText, stepCountIs } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ToolSet } from 'ai'
import { planNoteFixture } from '@orc/contracts/fixtures'
import type { OrcActions } from './actions'
import type { ProjectSessions } from './sessions'
import type { TranscriptItem } from './transcript'
import { asResolvedTools, buildCopilotTools, copilotSystemPrompt } from './copilot'

// Honest stubs for the ui-core ports this suite drives: every member throws unless overridden,
// so an unexercised call surfaces loudly instead of a cast pretending the object is complete.
// ponytail: mirrors the e2e fixture's unsupported() helper; promote to a shared test-helper if a
// third suite needs it.
const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not available in this test`) }
const sessionsStub = (over: Partial<ProjectSessions> = {}): ProjectSessions => ({
  projects: unsupported('projects'), snapshot: unsupported('snapshot'), subscribe: unsupported('subscribe'),
  subscribeProjects: unsupported('subscribeProjects'), notifyProjectsChanged: unsupported('notifyProjectsChanged'),
  since: unsupported('since'), nodeDetail: unsupported('nodeDetail'), modelCatalog: unsupported('modelCatalog'),
  reset: unsupported('reset'), transcript: unsupported('transcript'), taskPlans: unsupported('taskPlans'),
  planNotes: unsupported('planNotes'), log: unsupported('log'), close: unsupported('close'), ...over,
})
const actionsStub = (over: Partial<OrcActions> = {}): OrcActions => ({
  newTask: unsupported('newTask'), propose: unsupported('propose'), edit: unsupported('edit'),
  approve: unsupported('approve'), run: unsupported('run'), reply: unsupported('reply'),
  retry: unsupported('retry'), annotate: unsupported('annotate'), revise: unsupported('revise'),
  writeNote: unsupported('writeNote'), deleteNote: unsupported('deleteNote'),
  renameProject: unsupported('renameProject'), newProject: unsupported('newProject'),
  cancel: unsupported('cancel'), purgeProject: unsupported('purgeProject'), deleteProject: unsupported('deleteProject'), ...over,
})

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

const stubSessions = sessionsStub({
  snapshot: async () => ({
    seq: 1,
    graph: { nodes: [{ id: 't1', type: 'task', label: 'build it', detail: 'draft' }], links: [] },
  }),
  taskPlans: async () => null,
  transcript: async () => [],
  planNotes: async () => ({ notes: [], mermaid: null }),
  log: async () => [],
})

describe('copilot tools', () => {
  it('read tools ground the model; the loop runs tool → answer', async () => {
    const tools = buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1' })
    const result = await generateText({
      model: scriptModel([
        { toolCalls: [{ toolCallId: 'c1', toolName: 'project_status', input: {} }] },
        { text: 'you have one draft task: build it' },
      ]),
      system: copilotSystemPrompt('test', 'read-only'),
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
    const tools = asResolvedTools(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1' }))
    const status = tools.find(t => t.name === 'project_status')!
    expect(status.inputSchema.type).toBe('object')
    expect(status.inputSchema.$schema).toBeUndefined() // stripped for MCP
    const r = await status.execute({}, undefined)
    expect(r.isError).toBe(false)
    expect(r.output).toHaveProperty('tasks')
  })

  it('project_status carries memory health when the probe is wired — a rebuilding read model must be visible at the door, not only in the DB', async () => {
    const health = async () => ({ memory: { state: 'catching_up' as const, pending: 372, reason: '372 event(s) not yet projected' } })
    const tools = asResolvedTools(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1', health }))
    const r = await tools.find(t => t.name === 'project_status')!.execute({}, undefined)
    expect(r.isError).toBe(false)
    expect(r.output).toHaveProperty('memory', { state: 'catching_up', pending: 372, reason: '372 event(s) not yet projected' })

    // probe absent → field omitted, never a fabricated "ok"
    const bare = asResolvedTools(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1' }))
    const r2 = await bare.find(t => t.name === 'project_status')!.execute({}, undefined)
    expect(r2.output).not.toHaveProperty('memory')

    // probe failure → unreachable with the reason, mirroring graph-ui's /api/health posture
    const failing = asResolvedTools(buildCopilotTools({
      sessions: stubSessions, actions: null, projectId: 'p1',
      health: async () => { throw new Error('surreal is down') },
    }))
    const r3 = await failing.find(t => t.name === 'project_status')!.execute({}, undefined)
    expect(r3.isError).toBe(false)
    expect(r3.output).toHaveProperty('memory', { state: 'unreachable', pending: 0, reason: 'surreal is down' })
  })

  // `visual` is an ALLOWLIST, not a spread. The field it was built for (a mermaid diagram string)
  // is gone, so the stub below smuggles an unknown one in its place: the point was never mermaid
  // specifically, it is that a field added to taskPlans for the BROWSER must not silently start
  // costing model tokens on every task_plan call.
  it('task_plan passes only the visual fields a driver can act on, dropping any other', async () => {
    const withPlan = sessionsStub({
      taskPlans: async () => ({
        versions: [{ taskId: 't1', version: 1, strategyRef: 's', costEstimateUSD: null, steps: [] }], approvedVersion: 1,
        visual: { version: 1, renderedForTheBrowser: 'graph TD\n a-->b', waves: [{ wave: 1, parallel: false, steps: [] }] },
      }),
    })
    const tools = asResolvedTools(buildCopilotTools({ sessions: withPlan, actions: null, projectId: 'p1' }))
    const r = await tools.find(t => t.name === 'task_plan')!.execute({ taskId: 't1' }, undefined)
    expect(r.isError).toBe(false)
    expect(JSON.stringify(r.output)).not.toContain('graph TD')
    expect(JSON.stringify(r.output)).toContain('"waves"')
  })

  it('the human gate is structural: no approve tool even with actions wired', () => {
    const acting = buildCopilotTools({ sessions: stubSessions, actions: actionsStub(), projectId: 'p1' })
    expect(Object.keys(acting)).toContain('run')
    expect(Object.keys(acting)).toContain('reply')
    expect(Object.keys(acting)).not.toContain('approve')
    expect(copilotSystemPrompt('proj', 'act')).toContain('HUMAN-ONLY')
  })

  it('available_models lists live refs and only exists when discovery is wired', async () => {
    const tools = buildCopilotTools({
      sessions: stubSessions, actions: null, projectId: 'p1',
      listModels: async () => ['anthropic/claude-x', 'ollama/llama3.2:3b'],
    })
    expect(Object.keys(tools)).toContain('available_models')
    expect(Object.keys(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1' }))).not.toContain('available_models')
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
    const tools = buildCopilotTools({ sessions: stubSessions, actions, projectId: 'p1' })
    expect(Object.keys(tools)).toContain('new_request')
    expect(Object.keys(buildCopilotTools({ sessions: stubSessions, actions: null, projectId: 'p1' }))).not.toContain('new_request')

    const result = await generateText({
      model: scriptModel([
        { toolCalls: [{ toolCallId: 'c1', toolName: 'new_request', input: { title: 'demo request' } }] },
        { text: 'created t-new' },
      ]),
      messages: [{ role: 'user', content: 'make a request called demo request' }],
      tools,
      stopWhen: stepCountIs(3),
    })
    expect(calls).toEqual([{ title: 'demo request' }])
    expect(result.text).toContain('t-new')
  })
})

// Door #2 shape: call through asResolvedTools so the assertions run against the SAME
// safeParse-then-execute path an MCP client hits with raw JSON.
const callTool = async (tools: ToolSet, name: string, input: unknown) =>
  asResolvedTools(tools).find(t => t.name === name)!.execute(input, undefined)

const toolItem = (over: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): TranscriptItem => ({
  kind: 'tool', iteration: 1, stepId: 's1', toolName: 'fs_read',
  input: { path: 'p'.repeat(600) }, output: { content: 'c'.repeat(900) }, isError: false, ...over,
})
const QUESTION: TranscriptItem = { kind: 'question', stepId: 's1', question: 'which cwd?'.repeat(80), answer: null }
const SIGNAL: TranscriptItem = { kind: 'signal', stepId: 's1', outcome: 'success', summary: 'done '.repeat(120) }

describe('task_transcript (bounded for the MCP door)', () => {
  it('snips tool input/output to strings and leaves questions/signals verbatim', async () => {
    const items = [toolItem(), QUESTION, SIGNAL]
    const tools = buildCopilotTools({
      sessions: sessionsStub({ transcript: async () => items }), actions: null, projectId: 'p1',
    })
    const r = await callTool(tools, 'task_transcript', { taskId: 't1' })
    expect(r.isError).toBe(false)
    const out = r.output as TranscriptItem[]
    const mappedTool = out[0] as { input: unknown; output: unknown }
    expect(typeof mappedTool.input).toBe('string')
    expect(typeof mappedTool.output).toBe('string')
    expect((mappedTool.input as string).length).toBeLessThanOrEqual(401)
    expect((mappedTool.output as string).length).toBeLessThanOrEqual(401)
    // a driver must read a question and a signal EXACTLY — no snip, no reshape
    expect(out[1]).toEqual(QUESTION)
    expect(out[2]).toEqual(SIGNAL)
  })

  it('limit returns the LAST n items', async () => {
    const items = [1, 2, 3, 4, 5].map(i => toolItem({ toolName: `t${i}`, input: {}, output: null }))
    const tools = buildCopilotTools({
      sessions: sessionsStub({ transcript: async () => items }), actions: null, projectId: 'p1',
    })
    const r = await callTool(tools, 'task_transcript', { taskId: 't1', limit: 2 })
    expect((r.output as Array<{ toolName: string }>).map(i => i.toolName)).toEqual(['t4', 't5'])
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
      sessions: sessionsStub({ planNotes: async () => ({ notes: [note], mermaid: null }) }),
      actions: null, projectId: 'p1',
    })
    const r = await callTool(tools, 'plan_notes', { taskId: 't1' })
    const [out] = r.output as Array<Record<string, unknown>>
    expect(out).toMatchObject({
      id: 'sub-a', dependsOn: ['generate-doc'], zone: ['docs/**'],
      skillRefs: ['role-auditor'], toolRefs: ['web/search'], modelRef: 'anthropic/claude-haiku-4-5',
    })
    expect(typeof out!.body).toBe('string')
    expect((out!.body as string).length).toBeLessThanOrEqual(401)
  })

  it('omits modelRef entirely when the subplan inherits the parent model', async () => {
    const tools = buildCopilotTools({
      sessions: sessionsStub({ planNotes: async () => ({ notes: [planNoteFixture({ modelRef: '' })], mermaid: null }) }),
      actions: null, projectId: 'p1',
    })
    const [out] = (await callTool(tools, 'plan_notes', { taskId: 't1' })).output as Array<Record<string, unknown>>
    expect(out).not.toHaveProperty('modelRef')
  })
})

describe('recent_activity (pollable)', () => {
  const row = (seq: number, kind: string) => ({
    seq, ts: '2026-07-30T00:00:00.000Z', kind, taskId: 't1', stepId: null,
    line: `${kind} ${seq}`, authorTaskId: null, noteRef: null,
  })

  it('returns { rows, maxSeq } and passes sinceSeq/kinds through to the log read', async () => {
    const seen: unknown[] = []
    const tools = buildCopilotTools({
      sessions: sessionsStub({
        log: async (_p, opts) => { seen.push(opts); return [row(7, 'step_started'), row(9, 'step_completed')] },
      }),
      actions: null, projectId: 'p1',
    })
    const r = await callTool(tools, 'recent_activity', { sinceSeq: 5, kinds: ['step_started', 'step_completed'], limit: 3 })
    expect(r.output).toEqual({ rows: [row(7, 'step_started'), row(9, 'step_completed')], maxSeq: 9 })
    expect(seen).toEqual([{ taskId: undefined, limit: 3, sinceSeq: 5, kinds: ['step_started', 'step_completed'] }])
  })

  it('maxSeq is null when nothing is new; sinceSeq/kinds are absent (not undefined) when unset', async () => {
    const seen: unknown[] = []
    const tools = buildCopilotTools({
      sessions: sessionsStub({ log: async (_p, opts) => { seen.push(opts); return [] } }),
      actions: null, projectId: 'p1',
    })
    const r = await callTool(tools, 'recent_activity', {})
    expect(r.output).toEqual({ rows: [], maxSeq: null })
    expect(Object.keys(seen[0] as object).sort()).toEqual(['limit', 'taskId'])
  })

  it('rejects a kind that is not in the EventKind vocabulary', async () => {
    const tools = buildCopilotTools({
      sessions: sessionsStub({ log: async () => [] }), actions: null, projectId: 'p1',
    })
    const r = await callTool(tools, 'recent_activity', { kinds: ['not_a_kind'] })
    expect(r.isError).toBe(true)
  })
})
