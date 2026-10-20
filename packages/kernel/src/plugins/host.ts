import type { AgentExecutor, Analyzer, ExtensionApi, ModelProvider, Plan } from '@orc/contracts'
import { errorMessage, HookName, IsolationTier, parseModelRef, parseToolRef } from '@orc/contracts'
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
  // resolved relative to the PROJECT: a worktree trusts the same set the main checkout declared
  await extensions.load(config.extensions, decl => isExtensionTrusted(loadTrust(config.projectRoot), decl, config.projectRoot), config.projectRoot)
  const skills = await SkillIndex.open(config.skillsDir)
  // session_shutdown has no dedupe of its own: a second emit notifies every listener again
  let shutDown = false

  return {
    providers, executors, analyzers, skills, hooks, extensions,
    refValidator: async plan => {
      const errors: string[] = []
      // read fresh per validation: a revoked grant or edited declaration must be seen
      const trust = loadTrust(config.projectRoot)
      const byName = new Map(skills.list().map(e => [e.name, e]))
      for (const step of plan.steps) {
        if (!executors.has(step.executorRef)) errors.push(`step ${step.id}: unknown executor '${step.executorRef}'`)
        const { providerId } = parseModelRef(step.modelRef)
        if (!providers.has(providerId)) errors.push(`step ${step.id}: unknown provider '${providerId}'`)
        // only 'local' execution exists — reject tiers a plan promises but no sandbox delivers yet
        if (step.isolation !== IsolationTier.local)
          errors.push(`step ${step.id}: isolation '${step.isolation}' is not implemented yet (only 'local')`)
        for (const ref of step.skillRefs) {
          const entry = byName.get(ref)
          if (!entry) errors.push(`step ${step.id}: unknown skill '${ref}' — \`orc skills\` lists the index; \`orc init\` seeds the shipped set`)
          else if (!entry.valid) errors.push(`step ${step.id}: invalid skill '${ref}' (${entry.errors.join('; ')})`)
        }
        for (const ref of step.toolRefs) {
          try {
            const { serverId } = parseToolRef(ref)
            const declared = config.mcpServers[serverId]
            if (!declared) errors.push(`step ${step.id}: undeclared MCP server '${serverId}'`)
            else if (!isMcpTrusted(trust, serverId, declared)) errors.push(`step ${step.id}: MCP server '${serverId}' is not trusted (orc mcp trust ${serverId})`)
          } catch (err) {
            errors.push(`step ${step.id}: ${errorMessage(err)}`)
          }
        }
      }
      if (plan.analyzerRef && !analyzers.has(plan.analyzerRef)) errors.push(`unknown analyzer '${plan.analyzerRef}'`)
      return errors
    },
    shutdown: async () => {
      if (shutDown) return
      shutDown = true
      await hooks.drain()
      await hooks.emit(HookName.session_shutdown)
      await extensions.shutdown()
      skills.close()
    },
  }
}
