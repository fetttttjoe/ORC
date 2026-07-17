import { apiLoopExecutor } from '@orc/executor-api-loop'
import { createAnthropicProvider } from '@orc/provider-anthropic'
import { createOpenAIProvider } from '@orc/provider-openai'
import { createOllamaProvider } from '@orc/provider-ollama'
import type { AgentExecutor, ModelProvider } from '@orc/contracts'
import { createDbosPort, loadConfig, EventLog, type DbosPort } from '@orc/kernel'

export async function buildRuntime(): Promise<DbosPort> {
  const config = loadConfig()
  const log = await EventLog.open(config.databaseUrl)
  const providers = new Map<string, ModelProvider<unknown>>([
    ['anthropic', createAnthropicProvider(config.costOverrides['anthropic'] ?? {}) as ModelProvider<unknown>],
    ['openai', createOpenAIProvider(config.costOverrides['openai'] ?? {}) as ModelProvider<unknown>],
    ['ollama', createOllamaProvider({ baseUrl: config.ollamaBaseUrl, costOverrides: config.costOverrides['ollama'] ?? {} }) as ModelProvider<unknown>],
  ])
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor() as AgentExecutor<unknown>]])
  const port = await createDbosPort({ log, config, providers, executors })
  await port.launch()
  return port
}
