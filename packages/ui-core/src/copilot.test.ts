import { describe, expect, it } from 'bun:test'
import { generateText, stepCountIs } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { OrcActions } from './actions'
import type { ProjectSessions } from './sessions'
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
