import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ApprovedBy, Door, EVENT_KIND, KnowledgeHealthState, ModelsDiscoveredPayload, NO_CHAT, isRecord } from '@orc/contracts'
import { authorFixture, must } from '@orc/contracts/fixtures'
import { createKnowledgePort, createInMemoryBackend, KNOWLEDGE_READ_TOOLS, knowledgeHealth, knowledgeTools, NO_STRUCTURE } from '@orc/knowledge-core'
import { buildCopilotTools } from '@orc/ui-core'
import { openStorage } from '@orc/kernel'
import { createTestDb, testConfig, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { buildModelDiscovery } from './actions'
import { buildServeTools, mcpApproveTool, serveHealth } from './mcp-serve'
import { actionsStub, sessionsStub } from './test-helpers'

// every tool this door serves names the MCP door; the tests assert that literal, never a default
const MCP = NO_CHAT(Door.mcp)

// under `mcp serve` stdout carries only JSON-RPC frames: one stray boot print corrupts it

const dbs: Array<{ drop: () => Promise<void> }> = []
// stand-in provider daemons: stopped with their connections, or a pending fetch outlives the file
const servers: Array<{ stop: (closeActive?: boolean) => Promise<void> }> = []
afterAll(async () => {
  for (const s of servers) await s.stop(true)
  for (const d of dbs) await d.drop()
})

const frame = (o: unknown): string => JSON.stringify(o) + '\n'

// wire shapes narrowed with isRecord on purpose, so the pinned shape cannot drift with a schema
interface RpcFrame { jsonrpc?: string; id?: number; result?: unknown }
const asRpcFrame = (line: string): RpcFrame => {
  const v: unknown = JSON.parse(line)
  if (!isRecord(v)) throw new Error(`not a JSON-RPC frame: ${line}`)
  const { jsonrpc, id } = v
  if (jsonrpc !== undefined && typeof jsonrpc !== 'string') throw new Error('jsonrpc is not a string')
  if (id !== undefined && typeof id !== 'number') throw new Error('id is not a number')
  return { jsonrpc, id, result: v.result }
}
// tools/list result → the tool names it advertises
const toolNames = (result: unknown): string[] => {
  if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error('not a tools/list result')
  return result.tools.map(t => {
    if (!isRecord(t) || typeof t.name !== 'string') throw new Error('tool entry has no name')
    return t.name
  })
}
// tools/call result → its text blocks + isError flag
interface CallResult { content: Array<{ text: string }>; isError: boolean }
const asCallResult = (result: unknown): CallResult => {
  if (!isRecord(result) || typeof result.isError !== 'boolean' || !Array.isArray(result.content))
    throw new Error('not a tools/call result')
  const content = result.content.map(c => {
    if (!isRecord(c) || typeof c.text !== 'string') throw new Error('content block has no text')
    return { text: c.text }
  })
  return { content, isError: result.isError }
}
// a tool's JSON text payload as an object; individual fields are asserted by each test
const asJsonObject = (text: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(text)
  if (!isRecord(v)) throw new Error('tool payload is not a JSON object')
  return v
}

describe('orc mcp serve (stdio, read slice)', () => {
  it('speaks clean JSON-RPC on stdout: initialize, tools/list, tools/call', async () => {
    const db = await createTestDb()
    dbs.push(db)
    // a minimal real project dir: bin.ts requireProject(loadConfig()) reads .orc/config.json
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-mcp-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', 'config.json'),
      JSON.stringify({ projectId: TEST_PROJECT_ID, projectName: 'mcp-e2e' }))

    const bin = path.resolve(import.meta.dir, 'bin.ts')
    const proc = Bun.spawn(['bun', bin, 'mcp', 'serve'], {
      cwd: dir,
      env: { ...process.env, ORC_DATABASE_URL: db.url },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    proc.stdin.write(frame({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }))
    proc.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    proc.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    proc.stdin.write(frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_status', arguments: {} } }))
    // the human gate under the default dial: approve must REFUSE with the path forward
    proc.stdin.write(frame({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve', arguments: { taskId: 'any' } } }))
    // a mutation that needs no port: quick create through the same OrcActions the web uses
    proc.stdin.write(frame({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'new_request', arguments: { title: 'from claude' } } }))
    await proc.stdin.flush()

    // read stdout until the tools/call response (id 3) or timeout
    const decoder = new TextDecoder()
    let out = ''
    const deadline = Date.now() + 25_000
    const reader = proc.stdout.getReader()
    // responses may arrive out of order: wait until every expected id has answered
    const allIn = (): boolean => [1, 2, 3, 4, 5].every(id => out.includes(`"id":${id}`))
    while (Date.now() < deadline && !allIn()) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>(r => setTimeout(() => r({ done: true }), 1_000)),
      ])
      if (chunk.value) out += decoder.decode(chunk.value)
    }
    proc.stdin.end()
    proc.kill()

    const lines = out.split('\n').filter(l => l.trim() !== '')
    expect(lines.length).toBeGreaterThanOrEqual(3) // initialize, tools/list, tools/call responses
    // THE acceptance: every stdout line is a JSON-RPC frame — nothing else leaked
    const parsed = lines.map(asRpcFrame)
    for (const p of parsed) expect(p.jsonrpc).toBe('2.0')

    // the exact wire surface, not a subset: a toContain loop cannot see a tool that appeared
    const frame2 = must(parsed.find(p => p.id === 2), 'tools/list response frame')
    const names = toolNames(frame2.result)
    expect(new Set(names)).toEqual(new Set([
      'project_status', 'task_plan', 'task_transcript', 'plan_notes', 'recent_activity', 'available_models',
      'decision_list', 'decision_read',
      'knowledge_card', 'knowledge_search',
      'new_request', 'workspace_list', 'workspace_new', 'record_decision',
      'propose', 'run', 'reply', 'retry', 'cancel', 'annotate', 'revise', 'approve',
    ]))
    // record_decision is the one knowledge write this door gets: a decision has a fixed layout
    expect(names).not.toContain('memory_write')
    expect(names).not.toContain('knowledge_write')

    const frame3 = must(parsed.find(p => p.id === 3), 'tools/call frame')
    const call = asCallResult(frame3.result)
    expect(call.isError).toBe(false)
    const callContent0 = must(call.content[0], 'first content block')
    expect(Array.isArray(asJsonObject(callContent0.text).tasks)).toBe(true)

    // the dial holds: gated approve refuses and names the way forward
    const frame4 = must(parsed.find(p => p.id === 4), 'gated approve frame')
    const gate = asCallResult(frame4.result)
    expect(gate.isError).toBe(true)
    const gateContent0 = must(gate.content[0], 'first gate content block')
    expect(gateContent0.text).toContain('human gate')
    expect(gateContent0.text).toContain('--autonomy full')

    // mutations flow through the same OrcActions as the web door
    const frame5 = must(parsed.find(p => p.id === 5), 'new_request response frame')
    const created = asCallResult(frame5.result)
    expect(created.isError).toBe(false)
    const createdContent0 = must(created.content[0], 'first created content block')
    expect(asJsonObject(createdContent0.text)).toHaveProperty('taskId')
  }, 40_000)

  it('door parity is mechanical: every copilot tool is served, no memory tool is', () => {
    // if this fails the doors drifted: a copilot tool was added or renamed without the MCP surface
    const sessions = sessionsStub()
    const actions = actionsStub()
    const served = buildServeTools({
      sessions, projectId: 'p1', actions, autonomy: 'gated',
      knowledgeTools: knowledgeTools({ unavailable: 'parity-check' }, authorFixture(), KNOWLEDGE_READ_TOOLS),
    }).map(t => t.name)
    // a per-name toContain cannot see a tool the composition gained
    const copilot = Object.keys(buildCopilotTools({ sessions, actions, projectId: 'p1', origin: MCP, listModels: async () => [] }))
    expect(new Set(served)).toEqual(new Set([...copilot, ...KNOWLEDGE_READ_TOOLS, 'approve']))
  })

  it('project_status reports knowledge unavailable with the reason when the knowledge backend cannot answer', async () => {
    const unavailable = { unavailable: 'no checkout' }
    const served = buildServeTools({
      sessions: sessionsStub({ snapshot: async () => ({ seq: 1, graph: { nodes: [], links: [] } }) }), projectId: 'p1', actions: null, autonomy: 'gated',
      knowledgeTools: [],
      health: async () => ({ knowledge: await knowledgeHealth(unavailable, authorFixture()) }),
    })
    const status = must(served.find(t => t.name === 'project_status'), 'project_status')
    expect((await status.execute({}, undefined)).output).toHaveProperty('knowledge', { state: KnowledgeHealthState.unavailable, reason: 'no checkout' })
  })

  it('project_status computes knowledge health once within the TTL', async () => {
    let probes = 0
    const port = createKnowledgePort({
      backend: createInMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null }),
      checkoutOf: async () => { probes += 1; return '/checkout' },
      append: async () => {},
      warn: () => {},
    })
    const served = buildServeTools({
      sessions: sessionsStub({ snapshot: async () => ({ seq: 1, graph: { nodes: [], links: [] } }) }), projectId: 'p1', actions: null, autonomy: 'gated',
      knowledgeTools: [],
      health: serveHealth({ port }, authorFixture()),
    })
    const status = must(served.find(t => t.name === 'project_status'), 'project_status')
    await status.execute({}, undefined)
    const afterFirst = probes
    await status.execute({}, undefined)
    expect(afterFirst).toBeGreaterThan(0)
    expect(probes).toBe(afterFirst)
  })

  // a stand-in ollama daemon gives discovery one provider that certainly answers
  async function modelDoor(seed: Array<{ providerId: string; models: string[] }>, live = ['llama3.2:3b']) {
    const db = await createTestDb()
    dbs.push(db)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    const log = storage.events
    for (const payload of seed)
      await log.append({ ...MCP, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.models_discovered, payload })
    const daemon = Bun.serve({ port: 0, fetch: () => Response.json({ models: live.map(name => ({ name })) }) })
    servers.push(daemon)
    const config = testConfig(db.url, { ollamaBaseUrl: `http://localhost:${daemon.port}` })
    const discovery = buildModelDiscovery(config, { log, origin: MCP }, 2000)
    const actions = actionsStub({ listModels: discovery.listModels })
    const served = buildServeTools({
      sessions: sessionsStub(), projectId: 'p1', actions, autonomy: 'gated',
      knowledgeTools: knowledgeTools({ unavailable: 'model-door' }, authorFixture(), KNOWLEDGE_READ_TOOLS),
    })
    return { log, tool: must(served.find(t => t.name === 'available_models'), 'available_models tool') }
  }

  // the tool's output crosses no schema of its own; parsed here rather than narrowed by hand
  const refsOf = (output: unknown): string[] => z.object({ refs: z.array(z.string()) }).parse(output).refs
  const catalogFor = async (log: Awaited<ReturnType<typeof modelDoor>>['log'], providerId: string) => {
    const events = await log.after(0, [EVENT_KIND.models_discovered])
    return events.filter(e => ModelsDiscoveredPayload.parse(e.payload).providerId === providerId)
  }

  it('available_models on a log with NO models_discovered still names ids, and appends a catalog carrying Door.mcp', async () => {
    const { log, tool } = await modelDoor([])
    const result = await tool.execute({}, undefined)
    expect(result.isError).toBe(false)
    // the defect: folding an empty log answered [], and an agent that asked for models could name none
    expect(refsOf(result.output)).toContain('ollama/llama3.2:3b')
    const appended = await catalogFor(log, 'ollama')
    expect(appended).toHaveLength(1)
    expect(must(appended[0], 'appended ollama catalog').door).toBe(Door.mcp)
  })

  it('available_models discovers over a stale seeded catalog rather than serving it', async () => {
    const { log, tool } = await modelDoor([{ providerId: 'ollama', models: ['retired-model'] }], ['llama3.2:3b'])
    const refs = refsOf((await tool.execute({}, undefined)).output)
    expect(refs).toContain('ollama/llama3.2:3b')
    expect(refs).not.toContain('ollama/retired-model')
    // append-on-change: the fresh catalog is recorded beside the stale one, and it names this door
    const appended = await catalogFor(log, 'ollama')
    expect(appended).toHaveLength(2)
    expect(must(appended[1], 'fresh ollama catalog').door).toBe(Door.mcp)
  })

  it('mcpApproveTool: gated refuses without touching actions; full approves attributed as mcp', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({ approve: async (id, opts, origin) => { calls.push([id, opts, origin]); return { version: opts.version ?? 1 } } })
    const gated = await mcpApproveTool(actions, 'gated').execute({ taskId: 't1' }, undefined)
    expect(gated.isError).toBe(true)
    expect(calls).toHaveLength(0) // the gate is structural, not a failed call
    const full = await mcpApproveTool(actions, 'full').execute({ taskId: 't1', version: 2 }, undefined)
    expect(full.isError).toBe(false)
    // the door names its origin (Door.mcp) and its attribution (approvedBy) — identity, not authority
    expect(calls).toEqual([['t1', { version: 2, approvedBy: ApprovedBy.mcp }, MCP]])
  })

  // the input crosses a trust boundary: a typecast once let a non-string taskId into approve
  it('mcpApproveTool: malformed client input is a clean error, never a call into actions', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({ approve: async (id, opts, origin) => { calls.push([id, opts, origin]); return { version: opts.version ?? 1 } } })
    const tool = mcpApproveTool(actions, 'full')
    for (const bad of [undefined, {}, { taskId: 42 }, { taskId: '' }, { taskId: 't1', version: 0 }, { taskId: 't1', version: 1.5 }, { taskId: 't1', version: 'two' }]) {
      const r = await tool.execute(bad, undefined)
      expect(r.isError).toBe(true)
      expect(isRecord(r.output) && typeof r.output.error === 'string').toBe(true)
    }
    expect(calls).toHaveLength(0)
  })

  // same trust boundary for the copilot bridge: a numeric taskId once rode into actions.run
  it('bridged mutating tool (run): malformed client input is a clean error, never a call into actions', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({ run: async (id, cwd, origin) => { calls.push([id, cwd, origin]); return { requested: true, since: 0 } } })
    const sessions = sessionsStub()
    const served = buildServeTools({
      sessions, projectId: 'p1', actions, autonomy: 'gated',
      knowledgeTools: knowledgeTools({ unavailable: 'parity-check' }, authorFixture(), KNOWLEDGE_READ_TOOLS),
    })
    const run = must(served.find(t => t.name === 'run'), 'run tool')
    for (const bad of [undefined, {}, { taskId: 42, cwd: '/tmp' }, { taskId: 't1', cwd: { evil: true } }, { taskId: '', cwd: '/tmp' }]) {
      const r = await run.execute(bad, undefined)
      expect(r.isError).toBe(true)
      expect(isRecord(r.output) && typeof r.output.error === 'string').toBe(true)
    }
    expect(calls).toHaveLength(0)
  })
})
