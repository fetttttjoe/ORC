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
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ApprovedBy, Door, errorMessage, NO_CHAT, toolError, type MemoryAuthor, type ResolvedTool, type SupervisorHealth } from '@orc/contracts'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { probeMemory } from '@orc/memory'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import { KNOWLEDGE_READ_TOOLS, knowledgeTools } from '@orc/knowledge-core'
import { asResolvedTools, buildCopilotTools, createProjectSessions, type OrcActions } from '@orc/ui-core'

export type Autonomy = 'gated' | 'full'

// The zod twin of the advertised JSON inputSchema below. The input crosses a trust boundary —
// any MCP client can send any shape — and a typecast here once let a non-string taskId ride
// straight into actions.approve; the advertised schema is documentation, never enforcement.
const ApproveInput = z.object({ taskId: z.string().min(1), version: z.number().int().min(1).optional() })

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
      const parsed = ApproveInput.safeParse(input ?? {})
      if (!parsed.success) return toolError(parsed.error)
      try {
        return { output: await actions.approve(parsed.data.taskId, { ...(parsed.data.version !== undefined && { version: parsed.data.version }), approvedBy: ApprovedBy.mcp }, MCP_ORIGIN), isError: false }
      } catch (err) {
        return toolError(err)
      }
    },
  }
}

// Every tool call entered through THIS door; the door names it once, here.
const MCP_ORIGIN = NO_CHAT(Door.mcp)

// exported for the unit test: the registry is pure given its deps
export function buildServeTools(deps: {
  sessions: Parameters<typeof buildCopilotTools>[0]['sessions']
  projectId: string
  knowledgeTools: ResolvedTool[]
  actions: OrcActions | null
  autonomy: Autonomy
  health?: Parameters<typeof buildCopilotTools>[0]['health']
  listWorkspaces?: Parameters<typeof buildCopilotTools>[0]['listWorkspaces']
}): ResolvedTool[] {
  return [
    // one tool definition, two doors: the copilot set (read + mutate-without-approve, P2).
    // listModels is wired here too — this door drives agents that must never invent a model ref,
    // and the catalog is one more view over the read model this door already holds. An empty
    // catalog, never a 404: a project with no discovery yet has no models to name.
    ...asResolvedTools(buildCopilotTools({
      sessions: deps.sessions, actions: deps.actions, projectId: deps.projectId, origin: MCP_ORIGIN,
      // ONE core, two doors, no flag: it discovers here too — an agent answered { refs: [] } on a
      // project with no catalog yet cannot name a model. The stall is bounded inside discovery.
      listModels: async () => deps.actions ? deps.actions.listModels() : [],
      ...(deps.health && { health: deps.health }),
      ...(deps.listWorkspaces && { listWorkspaces: deps.listWorkspaces }),
    })),
    ...deps.knowledgeTools,
    ...(deps.actions ? [mcpApproveTool(deps.actions, deps.autonomy)] : []),
  ]
}

// The `executor` main.ts stamps on the author of this door's knowledge reads; shared so the name is spelled once.
export const MCP_SERVE_EXECUTOR = 'mcp-serve'

export async function startMcpServe(opts: {
  config: ProjectConfig
  log: EventLog
  actions: OrcActions | null // null = read-only server (no port factory available)
  autonomy: Autonomy
  // "is anything driving?" for project_status — injected because the heartbeat table and pid
  // file live behind the caller's storage; absent = the field is omitted, never fabricated
  supervisor?: () => Promise<SupervisorHealth>
  // "which checkout is this task in, and is it still going anywhere?" for project_status —
  // injected for the same reason supervisor is: this module holds a log and a sessions store,
  // never a kernel, and the health half also needs a filesystem probe and the note read model.
  // Typed off buildCopilotTools so this door and the console cannot drift on the shape.
  listWorkspaces?: Parameters<typeof buildCopilotTools>[0]['listWorkspaces']
  // Authors the knowledge_delivered evidence of this door's knowledge reads; built by main.ts, which holds the kernel.
  memoryAuthor: MemoryAuthor
}): Promise<void> {
  const { config, log, actions, autonomy, supervisor, listWorkspaces, memoryAuthor } = opts

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
  // the same probe `orc status` and graph-ui's /api/health read — an MCP driver watching a silent
  // project must be able to see "the read model is rebuilding" without opening the databases
  const tools = buildServeTools({
    sessions, projectId: config.projectId, actions, autonomy,
    knowledgeTools: knowledgeTools(knowledgeAccess(openKnowledge(config), log, config.dir), memoryAuthor, KNOWLEDGE_READ_TOOLS),
    ...(listWorkspaces && { listWorkspaces }),
    health: async () => ({
      memory: await probeMemory(config, log),
      ...(supervisor && { supervisor: await supervisor() }),
    }),
  })
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
  }
}
