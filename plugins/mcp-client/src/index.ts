import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  mcpToolName, parseToolRef,
  type McpServerConfig, type ResolvedTool, type ToolSource,
} from '@orc/contracts'

interface ToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }

// literal env values pass through unchanged; a value starting with '$' resolves from the orc
// process environment at spawn time — so secrets stay out of the committable config file and
// only ever live in whatever already set them in orc's own env. Unset/empty parent vars are
// dropped (container reality: `VAR=` is not a value), never passed through as the literal '$NAME'.
function resolveEnv(env: Record<string, string> | undefined, serverId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!value.startsWith('$')) {
      out[key] = value
      continue
    }
    const varName = value.slice(1)
    const resolved = process.env[varName]
    if (!resolved) {
      console.warn(`MCP server '${serverId}': env ${key} references unset $${varName} — omitted`)
      continue
    }
    out[key] = resolved
  }
  return out
}

export interface McpHub extends ToolSource {
  listTools(serverId: string): Promise<Array<{ name: string; description: string }>>
}

// T1 host: lazy spawn per server, cached client, tool list invalidated by list_changed,
// close() kills children (SDK-verified <300ms). Trust is enforced HERE too, not only at
// plan validation — a stale approved plan cannot spawn an untrusted server.
export function createMcpHub(
  servers: Record<string, McpServerConfig>,
  trustedMcp: ReadonlySet<string>,
): McpHub {
  const clients = new Map<string, Client>()
  const toolCache = new Map<string, ToolInfo[]>()

  async function ensureClient(serverId: string): Promise<Client> {
    const cfg = servers[serverId]
    if (!cfg) throw new Error(`undeclared MCP server '${serverId}' (declare it in .orc/config.json mcpServers)`)
    if (!trustedMcp.has(serverId)) throw new Error(`MCP server '${serverId}' is not trusted (orc mcp trust ${serverId})`)
    const existing = clients.get(serverId)
    if (existing) return existing
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...resolveEnv(cfg.env, serverId) }, // never full process.env (secrets)
      stderr: 'pipe',
    })
    const stderrChunks: string[] = []
    transport.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString()))
    const client = new Client({ name: 'orc', version: '0.1.0' })
    try {
      await client.connect(transport)
    } catch (err) {
      const detail = stderrChunks.join('').trim()
      throw new Error(
        `MCP server '${serverId}' failed to start: ${err instanceof Error ? err.message : String(err)}${detail ? ` — stderr: ${detail}` : ''}`,
      )
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      toolCache.delete(serverId)
    })
    clients.set(serverId, client)
    return client
  }

  async function toolsOf(serverId: string): Promise<ToolInfo[]> {
    const cached = toolCache.get(serverId)
    if (cached) return cached
    const client = await ensureClient(serverId)
    const res = await client.listTools()
    const tools = res.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }))
    toolCache.set(serverId, tools)
    return tools
  }

  const dropClient = async (serverId: string): Promise<void> => {
    const c = clients.get(serverId)
    clients.delete(serverId)
    toolCache.delete(serverId)
    await c?.close().catch(() => {})
  }

  return {
    async resolve(refs) {
      const out: ResolvedTool[] = []
      const seen = new Set<string>()
      for (const ref of refs) {
        const { serverId, toolName } = parseToolRef(ref)
        const client = await ensureClient(serverId) // bind the tool to this spawn generation
        const tools = await toolsOf(serverId)
        const tool = tools.find(t => t.name === toolName)
        if (!tool)
          throw new Error(`unknown tool '${toolName}' on MCP server '${serverId}' (available: ${tools.map(t => t.name).join(', ') || 'none'})`)
        const name = mcpToolName(serverId, toolName)
        if (seen.has(name)) throw new Error(`tool name collision after mangling: '${name}'`)
        seen.add(name)
        out.push({
          ref,
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: async input => {
            try {
              const r = await client.callTool({ name: toolName, arguments: (input ?? {}) as Record<string, unknown> })
              return { output: r.content, isError: r.isError === true }
            } catch (err) {
              // transport death is a tool error the model can react to; drop the client
              // so the next resolve lazily respawns (spec D9)
              await dropClient(serverId)
              return { output: { error: err instanceof Error ? err.message : String(err) }, isError: true }
            }
          },
        })
      }
      return out
    },
    async listTools(serverId) {
      return (await toolsOf(serverId)).map(t => ({ name: t.name, description: t.description }))
    },
    async close() {
      for (const id of [...clients.keys()]) await dropClient(id)
    },
  }
}
