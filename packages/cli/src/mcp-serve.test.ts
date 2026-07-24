import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isRecord } from '@orc/contracts'
import { buildCopilotTools, type OrcActions, type ProjectSessions } from '@orc/ui-core'
import { unavailableMemoryTools } from '@orc/memory'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { buildServeTools, mcpApproveTool } from './mcp-serve'

// P7 prerequisite acceptance: under `mcp serve`, stdout carries ONLY JSON-RPC frames — one
// stray boot print corrupts the channel. This drives a real spawned `orc mcp serve` through
// initialize → tools/list → tools/call and asserts every stdout line parses as JSON-RPC.

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { for (const d of dbs) await d.drop() })

const frame = (o: unknown): string => JSON.stringify(o) + '\n'

// --- JSON-RPC / MCP wire shapes this read-slice pins (cli has no zod; narrow with isRecord) ---
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

// Honest stubs for the ui-core ports this suite hands to buildServeTools/mcpApproveTool: every
// member throws unless overridden, so an unexercised call surfaces instead of a cast lying about
// completeness. ponytail: mirrors the e2e fixture's unsupported() helper (also in
// packages/ui-core/src/copilot.test.ts) — the shared home would be a production-source change.
const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not available in this test`) }
const sessionsStub = (over: Partial<ProjectSessions> = {}): ProjectSessions => ({
  projects: unsupported('projects'), snapshot: unsupported('snapshot'), subscribe: unsupported('subscribe'),
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
    // responses may arrive OUT OF ORDER (the SDK dispatches handlers concurrently) — wait
    // until every expected id has answered, not just the last one sent
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

    const names = toolNames(parsed.find(p => p.id === 2)!.result)
    for (const expected of ['project_status', 'task_plan', 'task_transcript', 'recent_activity',
      'memory_search', 'memory_read', 'memory_neighbors', 'new_request', 'propose', 'run', 'retry', 'cancel', 'approve'])
      expect(names).toContain(expected)
    expect(names).not.toContain('memory_write') // agents inside plans write; the driver does not

    const call = asCallResult(parsed.find(p => p.id === 3)!.result)
    expect(call.isError).toBe(false)
    expect(Array.isArray(asJsonObject(call.content[0]!.text).tasks)).toBe(true)

    // the dial holds: gated approve refuses and names the way forward
    const gate = asCallResult(parsed.find(p => p.id === 4)!.result)
    expect(gate.isError).toBe(true)
    expect(gate.content[0]!.text).toContain('human gate')
    expect(gate.content[0]!.text).toContain('--autonomy full')

    // mutations flow through the same OrcActions as the web door
    const created = asCallResult(parsed.find(p => p.id === 5)!.result)
    expect(created.isError).toBe(false)
    expect(asJsonObject(created.content[0]!.text)).toHaveProperty('taskId')
  }, 40_000)

  it('door parity is mechanical: every copilot tool is served, memory read names still exist', () => {
    // if this fails, the doors drifted — a copilot tool was added/renamed without the MCP
    // surface following (it follows automatically; this test proves it), or the memory
    // plugin renamed a read tool out from under the READ_MEMORY whitelist
    const sessions = sessionsStub()
    const actions = actionsStub()
    const memoryTools = unavailableMemoryTools('parity-check') // full named surface, no store needed
    const served = buildServeTools({ sessions, projectId: 'p1', memoryTools, actions, autonomy: 'gated' }).map(t => t.name)
    for (const name of Object.keys(buildCopilotTools({ sessions, actions, projectId: 'p1' })))
      expect(served).toContain(name)
    for (const name of ['memory_search', 'memory_read', 'memory_neighbors'])
      expect(served).toContain(name) // whitelist names must still exist in the memory plugin
    expect(served).toContain('approve')
    expect(served).not.toContain('memory_write')
  })

  it('mcpApproveTool: gated refuses without touching actions; full approves attributed as mcp', async () => {
    const calls: unknown[] = []
    const actions = actionsStub({ approve: async (id, v, by) => { calls.push([id, v, by]); return { version: v ?? 1 } } })
    const gated = await mcpApproveTool(actions, 'gated').execute({ taskId: 't1' }, undefined)
    expect(gated.isError).toBe(true)
    expect(calls).toHaveLength(0) // the gate is structural, not a failed call
    const full = await mcpApproveTool(actions, 'full').execute({ taskId: 't1', version: 2 }, undefined)
    expect(full.isError).toBe(false)
    expect(calls).toEqual([['t1', 2, 'mcp']])
  })
})
