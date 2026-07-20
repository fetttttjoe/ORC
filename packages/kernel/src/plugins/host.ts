import type { AgentExecutor, Analyzer, ExtensionApi, ModelProvider, Plan } from '@orc/contracts'
import { HOOK_NAME, ISOLATION_TIER, parseModelRef, parseToolRef } from '@orc/contracts'
import type { OrcConfig } from '../config'
import { SkillIndex } from './skills'
import { HookBus } from './hooks'
import { ExtensionHost } from './extensions'
import { isExtensionTrusted, isMcpTrusted, loadTrust } from './trust'

export interface PluginHost {
  providers: Map<string, ModelProvider<unknown>>
  executors: Map<string, AgentExecutor<unknown>>
  analyzers: Map<string, Analyzer>
  skills: SkillIndex
  hooks: HookBus
  extensions: ExtensionHost
  refValidator(plan: Plan): Promise<string[]>
  shutdown(): Promise<void>
}

export async function createPluginHost(
  config: OrcConfig,
  seed: {
    providers?: Map<string, ModelProvider<unknown>>
    executors?: Map<string, AgentExecutor<unknown>>
    analyzers?: Map<string, Analyzer>
  } = {},
): Promise<PluginHost> {
  const providers = seed.providers ?? new Map()
  const executors = seed.executors ?? new Map()
  const analyzers = seed.analyzers ?? new Map<string, Analyzer>()
  const hooks = new HookBus()

  const api: ExtensionApi = {
    registerProvider: (id, p) => {
      if (providers.has(id)) console.warn(`extension shadows provider '${id}'`)
      providers.set(id, p)
    },
    registerExecutor: (id, e) => {
      if (executors.has(id)) console.warn(`extension shadows executor '${id}'`)
      executors.set(id, e)
    },
    registerAnalyzer: (id, a) => {
      if (analyzers.has(id)) console.warn(`extension shadows analyzer '${id}'`)
      analyzers.set(id, a)
    },
    on: (hook, handler) => hooks.on(hook, handler),
  }
  const extensions = new ExtensionHost(api)
  await extensions.load(config.extensions, decl => isExtensionTrusted(loadTrust(config.dir), decl, config.dir), config.dir)
  const skills = await SkillIndex.open(config.skillsDir)

  return {
    providers, executors, analyzers, skills, hooks, extensions,
    refValidator: async plan => {
      const errors: string[] = []
      // read fresh per validation: a grant revoked (or a declaration edited) since process start
      // must be seen here, the way every other trust check in the codebase already does it
      const trust = loadTrust(config.dir)
      const byName = new Map(skills.list().map(e => [e.name, e]))
      for (const step of plan.steps) {
        if (!executors.has(step.executorRef)) errors.push(`step ${step.id}: unknown executor '${step.executorRef}'`)
        const { providerId } = parseModelRef(step.modelRef)
        if (!providers.has(providerId)) errors.push(`step ${step.id}: unknown provider '${providerId}'`)
        // only 'local' execution exists — reject tiers a plan promises but no sandbox delivers yet
        if (step.isolation !== ISOLATION_TIER.local)
          errors.push(`step ${step.id}: isolation '${step.isolation}' is not implemented yet (only 'local')`)
        for (const ref of step.skillRefs) {
          const entry = byName.get(ref)
          if (!entry) errors.push(`step ${step.id}: unknown skill '${ref}'`)
          else if (!entry.valid) errors.push(`step ${step.id}: invalid skill '${ref}' (${entry.errors.join('; ')})`)
        }
        for (const ref of step.toolRefs) {
          try {
            const { serverId } = parseToolRef(ref)
            const declared = config.mcpServers[serverId]
            if (!declared) errors.push(`step ${step.id}: undeclared MCP server '${serverId}'`)
            else if (!isMcpTrusted(trust, serverId, declared)) errors.push(`step ${step.id}: MCP server '${serverId}' is not trusted (orc mcp trust ${serverId})`)
          } catch (err) {
            errors.push(`step ${step.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      // analyzerRef is added to Plan in Task 4; inert cast until then
      const analyzerRef = (plan as { analyzerRef?: string }).analyzerRef
      if (analyzerRef && !analyzers.has(analyzerRef)) errors.push(`unknown analyzer '${analyzerRef}'`)
      return errors
    },
    shutdown: async () => {
      await hooks.drain()
      await hooks.emit(HOOK_NAME.session_shutdown)
      await extensions.shutdown()
      skills.close()
    },
  }
}
