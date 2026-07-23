import { errorMessage, HOOK_NAME, type AgentExecutor, type Analyzer, type MemoryAuthor, type ModelProvider, type ResolvedTool } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { createAnthropicProvider } from '@orc/provider-anthropic'
import { createOpenAIProvider } from '@orc/provider-openai'
import { createOllamaProvider } from '@orc/provider-ollama'
import { agentAnalyzer } from '@orc/analyzer-agent'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { createMemory, unavailableMemoryTools, tierForRole, type MemoryTier } from '@orc/memory'
import { createVaultProjector } from '@orc/vault-projector'
import { createDbosPort, createPluginHost, dbosSend, execTool, finalizePlanTool, isMcpTrusted, loadConfig, loadTrust, openStorage, readAnnotationsTool, reportCoverageTool, requireProject, splitTool, Kernel, type DbosPort, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'

export function seedRegistries(config = loadConfig()) {
  const providers = new Map<string, ModelProvider<unknown>>([
    ['anthropic', createAnthropicProvider(config.costOverrides['anthropic'] ?? {})],
    ['openai', createOpenAIProvider(config.costOverrides['openai'] ?? {})],
    ['ollama', createOllamaProvider({ baseUrl: config.ollamaBaseUrl, costOverrides: config.costOverrides['ollama'] ?? {} })],
  ])
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor()]])
  // config-driven iteration budget: the plugin keeps its own fallback; the project's
  // maxIterations wins at plan-authoring time (approved plans stay frozen).
  const base = agentAnalyzer()
  const analyzers = new Map<string, Analyzer>([['agent-analyzer', {
    ...base,
    analysisStep: opts => ({ ...base.analysisStep(opts), maxIterations: config.maxIterations }),
  }]])
  return { providers, executors, analyzers }
}

export async function buildPlugins(config = loadConfig()): Promise<{ host: PluginHost; hub: McpHub }> {
  const host = await createPluginHost(config, seedRegistries(config))
  // point-of-use enforcement (EXTENDING invariant 4): the fingerprint predicate runs against
  // a fresh trust read at spawn time, never a startup snapshot
  const hub = createMcpHub(config.mcpServers, (id, cfg) => isMcpTrusted(loadTrust(config.dir), id, cfg))
  return { host, hub }
}

export async function buildRuntime(
  shared?: { host: PluginHost; hub: McpHub; config?: ProjectConfig; storage?: Storage; kernel?: Kernel },
): Promise<DbosPort> {
  const config = shared?.config ?? requireProject(loadConfig())
  const { host, hub } = shared ?? (await buildPlugins(config))
  // reuse the caller's storage (bin passes the kernel's) — one pool, one lifecycle
  const storage = shared?.storage ?? (await openStorage(config.databaseUrl, { projectId: config.projectId, redactEnv: config.redactEnv }))
  const log = storage.events
  // reuse the caller's kernel (bin passes the one wired to its refValidator + analyzers) so
  // task_split's expanded child plans go through the same toolRef/skillRef validation as
  // `orc propose`, and createGroundedTask can resolve its analyzer.
  const kernel = shared?.kernel ?? new Kernel(log, host.refValidator, host.analyzers, dbosSend)
  log.onAppend = e => host.hooks.dispatch(HOOK_NAME.event_appended, e)

  // Startup order (design §8.4): projections FIRST — DBOS recovery may emit events the
  // moment it launches, and they must already be observed. Surreal failure degrades memory
  // (explicit unavailable tools) but never blocks history, execution, or the vault trace.
  const projector = createVaultProjector({ log, config })
  await projector.start()
  let memory: Awaited<ReturnType<typeof createMemory>> | null = null
  let buildMemoryTools: (author: MemoryAuthor, tier?: MemoryTier) => ResolvedTool[]
  try {
    memory = await createMemory({ log, config })
    await memory.projector.start()
    buildMemoryTools = memory.buildTools
  } catch (err) {
    const reason = errorMessage(err)
    console.warn(`memory unavailable; continuing in degraded mode: ${reason}`)
    buildMemoryTools = () => unavailableMemoryTools(reason)
  }

  const port = await createDbosPort({
    storage, config,
    providers: host.providers, executors: host.executors,
    skills: host.skills, tools: hub,
    stepTools: p => [
      // step role keys the memory tier (Task 7): scout/auditor narrow or widen the tool surface
      // + epistemic posture; every other role (e.g. plain worker steps) gets today's verify tier.
      ...buildMemoryTools(
        { source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role },
        tierForRole(p.role),
      ),
      splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
      // read_annotations only needs the kernel (reads plan_annotated off the log) — unconditional,
      // like splitTool: harmless everywhere, returns an empty list for a task with no annotations.
      readAnnotationsTool({ kernel, p }),
      // report_coverage emits analysis_completed; registration-gated inside the factory to the
      // scout analyze step — a tool that can only ever error must not be visible (scenario-2's
      // verify auditor burned one iteration per attempt calling it).
      ...reportCoverageTool({ kernel, p }),
      // exec runs operator-allowlisted commands (execAllowlist in .orc/config.json) in the step
      // workspace — the acceptance-gate tool. Empty allowlist = not offered.
      ...execTool({ workspaceDir: p.workspaceDir, allowlist: config.execAllowlist }),
      // finalize_plan reconstructs the plan-note graph from the log (kernel.listPlanNotes), not the
      // memory store — but it's still only offered when memory is healthy: with the memory tools
      // degraded the agent can't author a plan-note graph, so a grounded plan is pointless anyway.
      ...(memory ? [finalizePlanTool({ kernel, config: { maxDepth: config.maxDepth }, p })] : []),
    ],
  })
  await port.launch()
  host.skills.watch() // hot-index during long-lived runs (spec quality scenario: <1s)
  return {
    ...port,
    shutdown: async () => {
      await port.shutdown()
      if (memory) await memory.close()
      await projector.close()
      await host.shutdown() // drains hooks, fires session_shutdown, deactivates extensions, stops the watcher
      await hub.close()
    },
  }
}
