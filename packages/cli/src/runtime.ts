import { HOOK_NAME, type AgentExecutor, type ModelProvider } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { createAnthropicProvider } from '@orc/provider-anthropic'
import { createOpenAIProvider } from '@orc/provider-openai'
import { createOllamaProvider } from '@orc/provider-ollama'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { createDbosPort, createPluginHost, loadConfig, EventLog, type DbosPort, type OrcConfig, type PluginHost } from '@orc/kernel'

export function seedRegistries(config = loadConfig()) {
  const providers = new Map<string, ModelProvider<unknown>>([
    ['anthropic', createAnthropicProvider(config.costOverrides['anthropic'] ?? {}) as ModelProvider<unknown>],
    ['openai', createOpenAIProvider(config.costOverrides['openai'] ?? {}) as ModelProvider<unknown>],
    ['ollama', createOllamaProvider({ baseUrl: config.ollamaBaseUrl, costOverrides: config.costOverrides['ollama'] ?? {} }) as ModelProvider<unknown>],
  ])
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor() as AgentExecutor<unknown>]])
  return { providers, executors }
}

export async function buildPlugins(config = loadConfig()): Promise<{ host: PluginHost; hub: McpHub }> {
  const host = await createPluginHost(config, seedRegistries(config))
  const hub = createMcpHub(config.mcpServers, new Set(host.trust.mcp))
  return { host, hub }
}

export async function buildRuntime(
  shared?: { host: PluginHost; hub: McpHub; config?: OrcConfig; log?: EventLog },
): Promise<DbosPort> {
  const config = shared?.config ?? loadConfig()
  const { host, hub } = shared ?? (await buildPlugins(config))
  // reuse the caller's log (bin passes the kernel's) — one pool, migrations run once
  const log = shared?.log ?? (await EventLog.open(config.databaseUrl))
  log.onAppend = e => void host.hooks.emit(HOOK_NAME.event_appended, e)
  const port = await createDbosPort({
    log, config,
    providers: host.providers, executors: host.executors,
    skills: host.skills, tools: hub,
  })
  await port.launch()
  host.skills.watch() // hot-index during long-lived runs (spec quality scenario: <1s)
  return {
    ...port,
    shutdown: async () => {
      await hub.close()
      await host.shutdown() // fires session_shutdown, deactivates extensions, stops the watcher
      await port.shutdown()
    },
  }
}
