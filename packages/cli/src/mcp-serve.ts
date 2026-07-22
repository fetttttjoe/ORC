// orc mcp serve — door #2 of the two-doors model: an external agent (Claude Code, any MCP
// client) uses the substrate BEHIND the flow over stdio — event-sourced state, plans,
// transcripts, knowledge, and (this slice) mutations under an explicit autonomy dial.
//
// Autonomy is a LAUNCH-TIME choice, never the agent's (P2's lesson, structurally):
//   --autonomy gated (default): everything except approve; the human gate stays human.
//   --autonomy full: the client may approve — every approval is attributed `approvedBy: mcp`.
//
// stdout discipline, two layers:
//   1. bin.ts rebinds console log/info/debug → stderr BEFORE any boot code runs.
//   2. Here, the transport gets the REAL stdout and process.stdout.write is rerouted to
//      stderr — so when a mutation lazily boots DBOS, winston (which writes to
//      process.stdout directly, past console) cannot corrupt the protocol channel.
import { Writable } from 'node:stream'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage, type ResolvedTool } from '@orc/contracts'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { MEMORY_READ_TOOLS, MEMORY_TIER, createMemory, unavailableMemoryTools } from '@orc/memory'
import { asResolvedTools, buildCopilotTools, createProjectSessions, type OrcActions } from '@orc/ui-core'

export type Autonomy = 'gated' | 'full'

// the read slice of the memory surface — the OWNING package exports the names (a rename
// there fails its own tests, and this import follows automatically); write stays with the
// agents that run inside plans
const READ_MEMORY = new Set<string>(MEMORY_READ_TOOLS)

// The ONE approve tool for door #2 — exported for tests. Under `gated` it refuses with the
// path forward; under `full` it approves with source attribution. It exists as a separate
// tool (not in the copilot set) because the two doors differ EXACTLY here, by design.
export function mcpApproveTool(actions: OrcActions, autonomy: Autonomy): ResolvedTool {
  return {
    ref: 'orc/approve', name: 'approve',
    description: autonomy === 'full'
      ? 'Approve a proposed plan version. This session runs with --autonomy full — the approval is recorded as approvedBy: mcp.'
      : 'Approve a proposed plan version — REFUSES in this session (--autonomy gated, the default): the human approves in the orc UI or with `orc approve <taskId>`. Relaunch with `orc mcp serve --autonomy full` for headless approval.',
    inputSchema: {
      type: 'object', required: ['taskId'],
      properties: { taskId: { type: 'string' }, version: { type: 'integer', minimum: 1 } },
    },
    execute: async input => {
      if (autonomy !== 'full')
        return {
          output: { error: 'human gate: this server runs --autonomy gated — approval happens in the orc UI or `orc approve <taskId>`. Relaunch with `orc mcp serve --autonomy full` for headless approval.' },
          isError: true,
        }
      const { taskId, version } = (input ?? {}) as { taskId?: string; version?: number }
      if (!taskId) return { output: { error: 'taskId is required' }, isError: true }
      try {
        return { output: await actions.approve(taskId, version, 'mcp'), isError: false }
      } catch (err) {
        return { output: { error: errorMessage(err) }, isError: true }
      }
    },
  }
}

// exported for the unit test: the registry is pure given its deps
export function buildServeTools(deps: {
  sessions: Parameters<typeof buildCopilotTools>[0]['sessions']
  projectId: string
  memoryTools: ResolvedTool[]
  actions: OrcActions | null
  autonomy: Autonomy
}): ResolvedTool[] {
  return [
    // one tool definition, two doors: the copilot set (read + mutate-without-approve, P2)
    ...asResolvedTools(buildCopilotTools({ sessions: deps.sessions, actions: deps.actions, projectId: deps.projectId })),
    ...deps.memoryTools.filter(t => READ_MEMORY.has(t.name)),
    ...(deps.actions ? [mcpApproveTool(deps.actions, deps.autonomy)] : []),
  ]
}

export async function startMcpServe(opts: {
  config: ProjectConfig
  log: EventLog
  actions: OrcActions | null // null = read-only server (no port factory available)
  autonomy: Autonomy
}): Promise<void> {
  const { config, log, actions, autonomy } = opts

  // stdout hardening layer 2: the transport keeps the real stdout; everything else — winston
  // when DBOS boots for run/retry/cancel, any stray library print — lands on stderr.
  const realWrite = process.stdout.write.bind(process.stdout)
  const transportOut = new Writable({
    write(chunk, _enc, cb) { realWrite(chunk as Uint8Array); cb() },
  })
  process.stdout.write = ((chunk: never, enc?: never, cb?: never) =>
    process.stderr.write(chunk, enc, cb)) as typeof process.stdout.write

  const sessions = createProjectSessions({
    url: config.databaseUrl,
    cwdProject: { id: config.projectId, name: config.projectName, dir: config.dir },
  })
  // memory degrades, never blocks — same posture as every other surface
  let memory: Awaited<ReturnType<typeof createMemory>> | null = null
  let memoryTools: ResolvedTool[]
  try {
    memory = await createMemory({ log, config })
    memoryTools = memory.buildTools({ source: 'agent', executor: 'mcp-serve' }, MEMORY_TIER.verify)
  } catch (err) {
    memoryTools = unavailableMemoryTools(errorMessage(err))
  }
  const tools = buildServeTools({ sessions, projectId: config.projectId, memoryTools, actions, autonomy })
  const byName = new Map(tools.map(t => [t.name, t]))

  const server = new Server({ name: 'orc', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const t = byName.get(req.params.name)
    if (!t) return { content: [{ type: 'text' as const, text: `unknown tool '${req.params.name}'` }], isError: true }
    try {
      const r = await t.execute(req.params.arguments ?? {}, undefined)
      return { content: [{ type: 'text' as const, text: JSON.stringify(r.output) }], isError: r.isError }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: errorMessage(err) }], isError: true }
    }
  })

  const closed = new Promise<void>(resolve => { server.onclose = resolve })
  await server.connect(new StdioServerTransport(process.stdin, transportOut))
  console.error(
    `orc mcp server ready — project "${config.projectName}", ${tools.length} tools, autonomy ${autonomy}${actions ? '' : ' (read-only)'}`)
  try {
    await closed // stdin closing (client gone) resolves this — then clean up
  } finally {
    await sessions.close().catch(() => {})
    await memory?.close().catch(() => {})
  }
}
