// autonomy is a launch-time choice, never the agent's: --autonomy gated (default) or full
import { Writable } from 'node:stream'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ApprovedBy, Door, errorMessage, NO_CHAT, toolError, type Author, type ResolvedTool, type SupervisorHealth } from '@orc/contracts'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import { KNOWLEDGE_HEALTH_TTL_MS } from './knowledge-health-of'
import { memoizeFor } from './memoize-for'
import { KNOWLEDGE_READ_TOOLS, knowledgeHealth, knowledgeTools } from '@orc/knowledge-core'
import { asResolvedTools, buildCopilotTools, createProjectSessions, type OrcActions } from '@orc/ui-core'

export type Autonomy = 'gated' | 'full'

// the zod twin of the advertised inputSchema, which is documentation, never enforcement
const ApproveInput = z.object({ taskId: z.string().min(1), version: z.number().int().min(1).optional() })

// separate from the copilot set because the two doors differ exactly at approve
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

export function serveHealth(
  knowledge: Parameters<typeof knowledgeHealth>[0], author: Author, supervisor?: () => Promise<SupervisorHealth>,
) {
  const knowledgeOf = memoizeFor(KNOWLEDGE_HEALTH_TTL_MS, () => knowledgeHealth(knowledge, author))
  return async () => ({
    knowledge: await knowledgeOf(),
    ...(supervisor && { supervisor: await supervisor() }),
  })
}

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
    // listModels is wired here too: an agent that cannot name a model would invent one
    ...asResolvedTools(buildCopilotTools({
      sessions: deps.sessions, actions: deps.actions, projectId: deps.projectId, origin: MCP_ORIGIN,
      // no flag: it discovers here too, bounded inside discovery
      listModels: async () => deps.actions ? deps.actions.listModels() : [],
      ...(deps.health && { health: deps.health }),
      ...(deps.listWorkspaces && { listWorkspaces: deps.listWorkspaces }),
    })),
    ...deps.knowledgeTools,
    ...(deps.actions ? [mcpApproveTool(deps.actions, deps.autonomy)] : []),
  ]
}

// the `executor` main.ts names on this door's knowledge-read author, spelled once
export const MCP_SERVE_EXECUTOR = 'mcp-serve'

export async function startMcpServe(opts: {
  config: ProjectConfig
  log: EventLog
  actions: OrcActions | null // null = read-only server (no port factory available)
  autonomy: Autonomy
  // absent = the field is omitted, never fabricated
  supervisor?: () => Promise<SupervisorHealth>
  // typed off buildCopilotTools so this door and the console cannot drift on the shape
  listWorkspaces?: Parameters<typeof buildCopilotTools>[0]['listWorkspaces']
  // authors this door's knowledge_delivered evidence; built by main.ts, which holds the kernel
  author: Author
}): Promise<void> {
  const { config, log, actions, autonomy, supervisor, listWorkspaces, author } = opts

  // transport keeps the real stdout; stray prints (winston under DBOS boot) land on stderr
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
  const knowledge = knowledgeAccess(openKnowledge(config), log, config.dir)
  const tools = buildServeTools({
    sessions, projectId: config.projectId, actions, autonomy,
    knowledgeTools: knowledgeTools(knowledge, author, KNOWLEDGE_READ_TOOLS),
    ...(listWorkspaces && { listWorkspaces }),
    health: serveHealth(knowledge, author, supervisor),
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
