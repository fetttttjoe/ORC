import type { AgentExecutor, ExtensionApi, ModelProvider, Plan } from '@orc/contracts'
import { HOOK_NAME, parseToolRef } from '@orc/contracts'
import type { OrcConfig } from '../config'
import { SkillIndex } from './skills'
import { HookBus } from './hooks'
import { ExtensionHost } from './extensions'
import { loadTrust, type TrustStore } from './trust'

export interface PluginHost {
  providers: Map<string, ModelProvider<unknown>>
  executors: Map<string, AgentExecutor<unknown>>
  skills: SkillIndex
  hooks: HookBus
  extensions: ExtensionHost
  trust: TrustStore
  refValidator(plan: Plan): Promise<string[]>
  shutdown(): Promise<void>
}

export async function createPluginHost(
  config: OrcConfig,
  seed: { providers?: Map<string, ModelProvider<unknown>>; executors?: Map<string, AgentExecutor<unknown>> } = {},
): Promise<PluginHost> {
  const providers = seed.providers ?? new Map()
  const executors = seed.executors ?? new Map()
  const hooks = new HookBus()
  const trust = loadTrust(config.dir)

  const api: ExtensionApi = {
    registerProvider: (id, p) => {
      if (providers.has(id)) console.warn(`extension shadows provider '${id}'`)
      providers.set(id, p)
    },
    registerExecutor: (id, e) => {
      if (executors.has(id)) console.warn(`extension shadows executor '${id}'`)
      executors.set(id, e)
    },
    on: (hook, handler) => hooks.on(hook, handler),
  }
  const extensions = new ExtensionHost(api)
  await extensions.load(config.extensions, trust.extensions, config.dir)
  const skills = await SkillIndex.open(config.skillsDir)

  return {
    providers, executors, skills, hooks, extensions, trust,
    refValidator: async plan => {
      const errors: string[] = []
      const byName = new Map(skills.list().map(e => [e.name, e]))
      for (const step of plan.steps) {
        if (!executors.has(step.executorRef)) errors.push(`step ${step.id}: unknown executor '${step.executorRef}'`)
        const slash = step.modelRef.indexOf('/')
        const providerId = slash === -1 ? step.modelRef : step.modelRef.slice(0, slash)
        if (!providers.has(providerId)) errors.push(`step ${step.id}: unknown provider '${providerId}'`)
        for (const ref of step.skillRefs) {
          const entry = byName.get(ref)
          if (!entry) errors.push(`step ${step.id}: unknown skill '${ref}'`)
          else if (!entry.valid) errors.push(`step ${step.id}: invalid skill '${ref}' (${entry.errors.join('; ')})`)
        }
        for (const ref of step.toolRefs) {
          try {
            const { serverId } = parseToolRef(ref)
            if (!(serverId in config.mcpServers)) errors.push(`step ${step.id}: undeclared MCP server '${serverId}'`)
            else if (!trust.mcp.includes(serverId)) errors.push(`step ${step.id}: MCP server '${serverId}' is not trusted (orc mcp trust ${serverId})`)
          } catch (err) {
            errors.push(`step ${step.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      return errors
    },
    shutdown: async () => {
      await hooks.emit(HOOK_NAME.session_shutdown)
      await extensions.shutdown()
      skills.close()
    },
  }
}
