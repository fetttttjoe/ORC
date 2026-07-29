import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  errorMessage, toolError,
  isRecord, mcpToolName, parseToolRef,
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
  // predicate, not a startup snapshot: trust is re-evaluated at the moment a server is
  // spawned, so a declaration that changed after launch can never ride an old grant
  isTrusted: (serverId: string, cfg: McpServerConfig) => boolean,
): McpHub {
  const clients = new Map<string, Client>()
  let closed = false
  const toolCache = new Map<string, ToolInfo[]>()

  async function ensureClient(serverId: string): Promise<Client> {
    // Without this, the per-call respawn would resurrect a server after shutdown and leak the
    // process; resolve() clears the flag, so deliberate reuse still works.
    if (closed) throw new Error('MCP hub is closed')
    const cfg = servers[serverId]
    if (!cfg) throw new Error(`undeclared MCP server '${serverId}' (declare it in .orc/config.json mcpServers)`)
    if (!isTrusted(serverId, cfg)) throw new Error(`MCP server '${serverId}' is not trusted (orc mcp trust ${serverId})`)
    const existing = clients.get(serverId)
    if (existing) return existing
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...resolveEnv(cfg.env, serverId) }, // never full process.env (secrets)
      // NOT piped into the error message: a third-party server's stderr is untrusted output that
      // would land in the event log and the vault's log.md. Debuggability is not worth that —
      // see index.test.ts's "without leaking stderr".
      stderr: 'ignore',
    })
    const client = new Client({ name: 'orc', version: '0.1.0' })
    try {
      await client.connect(transport)
    } catch (err) {
      throw new Error(`MCP server '${serverId}' failed to start: ${errorMessage(err)}`)
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
      inputSchema: isRecord(t.inputSchema) ? t.inputSchema : {},
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
      // close() releases the servers; an explicit resolve is intent to use them again. The flag
      // only stops a STALE tool handle from resurrecting a hub nobody asked to reopen.
      closed = false
      const out: ResolvedTool[] = []
      const seen = new Set<string>()
      for (const ref of refs) {
        const { serverId, toolName } = parseToolRef(ref)
        await ensureClient(serverId) // fail fast here if the server is undeclared or untrusted
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
          // The client is fetched per CALL, never captured at resolve time. A step resolves its
          // tools at the start and calls them minutes later; capturing meant a server that died in
          // between left this closure holding a dead transport, so every later call returned
          // "Not connected" — observed live on a research step's first web search. One respawn and
          // retry turns that into a non-event; ensureClient re-checks the trust grant each time, so
          // a respawn can never reach a server the operator has not declared and trusted.
          execute: async input => {
            const args = isRecord(input) ? input : {}
            let last: unknown
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                const client = await ensureClient(serverId)
                const r = await client.callTool({ name: toolName, arguments: args })
                return { output: r.content, isError: r.isError === true }
              } catch (err) {
                last = err
                await dropClient(serverId) // a dead transport must never be reused
              }
            }
            return toolError(last)
          },
        })
      }
      return out
    },
    async listTools(serverId) {
      return (await toolsOf(serverId)).map(t => ({ name: t.name, description: t.description }))
    },
    async close() {
      closed = true
      for (const id of [...clients.keys()]) await dropClient(id)
    },
  }
}
