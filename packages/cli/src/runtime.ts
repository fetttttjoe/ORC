import { HOOK_NAME, type AgentExecutor, type ModelProvider } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { createAnthropicProvider } from '@orc/provider-anthropic'
import { createOpenAIProvider } from '@orc/provider-openai'
import { createOllamaProvider } from '@orc/provider-ollama'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { createMemory } from '@orc/memory'
import { createVaultProjector } from '@orc/vault-projector'
import { createDbosPort, createPluginHost, loadConfig, requireProject, splitTool, EventLog, Kernel, type DbosPort, type PluginHost, type ProjectConfig } from '@orc/kernel'

export function seedRegistries(config = loadConfig()) {
  const providers = new Map<string, ModelProvider<unknown>>([
    ['anthropic', createAnthropicProvider(config.costOverrides['anthropic'] ?? {})],
    ['openai', createOpenAIProvider(config.costOverrides['openai'] ?? {})],
    ['ollama', createOllamaProvider({ baseUrl: config.ollamaBaseUrl, costOverrides: config.costOverrides['ollama'] ?? {} })],
  ])
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor()]])
  return { providers, executors }
}

export async function buildPlugins(config = loadConfig()): Promise<{ host: PluginHost; hub: McpHub }> {
  const host = await createPluginHost(config, seedRegistries(config))
  const hub = createMcpHub(config.mcpServers, new Set(host.trust.mcp))
  return { host, hub }
}

export async function buildRuntime(
  shared?: { host: PluginHost; hub: McpHub; config?: ProjectConfig; log?: EventLog; kernel?: Kernel },
): Promise<DbosPort> {
  const config = shared?.config ?? requireProject(loadConfig())
  const { host, hub } = shared ?? (await buildPlugins(config))
  // reuse the caller's log (bin passes the kernel's) — one pool, migrations run once
  const log = shared?.log ?? (await EventLog.open(config.databaseUrl))
  // reuse the caller's kernel (bin passes the one wired to its refValidator) so task_split's
  // expanded child plans go through the same toolRef/skillRef validation as `orc propose`
  const kernel = shared?.kernel ?? new Kernel(log, host.refValidator)
  log.onAppend = e => void host.hooks.emit(HOOK_NAME.event_appended, e)
  const memory = await createMemory({ log, config })
  const port = await createDbosPort({
    log, config,
    providers: host.providers, executors: host.executors,
    skills: host.skills, tools: hub,
    stepTools: p => [
      ...memory.buildTools({ source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role }),
      splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
    ],
  })
  await port.launch()
  const projector = createVaultProjector({ log, config })
  await projector.start()
  await memory.projector.start()
  host.skills.watch() // hot-index during long-lived runs (spec quality scenario: <1s)
  return {
    ...port,
    shutdown: async () => {
      await memory.projector.close()
      await memory.close()
      await projector.close()
      await hub.close()
      await host.shutdown() // fires session_shutdown, deactivates extensions, stops the watcher
      await port.shutdown()
    },
  }
}
