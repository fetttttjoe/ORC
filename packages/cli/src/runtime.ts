import { errorMessage, HOOK_NAME, type AgentExecutor, type Analyzer, type MemoryAuthor, type ModelProvider } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { createAnthropicProvider } from '@orc/provider-anthropic'
import { createOpenAIProvider } from '@orc/provider-openai'
import { createOllamaProvider } from '@orc/provider-ollama'
import { agentAnalyzer } from '@orc/analyzer-agent'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { createMemory, createMemoryLifecycle, createGroundingSource, notesCiting, unavailableStepMemory, memoryRoleFor, type BindStep, type MemoryLifecycle } from '@orc/memory'
import { openMemory } from './memory-open'
import { buildDistiller } from './consolidation-distiller'
import { createVaultProjector } from '@orc/vault-projector'
import { commitTool, createDbosPort, createPluginHost, dbosSend, execTool, finalizePlanTool, isMcpTrusted, loadConfig, loadTrust, openStorage, readAnnotationsTool, reportCoverageTool, requireProject, scopedChangesTool, splitTool, Kernel, type DbosPort, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'

export function seedRegistries(config = loadConfig()) {
  const providers = new Map<string, ModelProvider<unknown>>([
    ['anthropic', createAnthropicProvider(config.costOverrides['anthropic'] ?? {})],
    ['openai', createOpenAIProvider(config.costOverrides['openai'] ?? {})],
    ['ollama', createOllamaProvider({ baseUrl: config.ollamaBaseUrl, costOverrides: config.costOverrides['ollama'] ?? {} })],
  ])
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor()]])
  // The config-driven iteration budget is applied by createGroundedTask, to BOTH template steps —
  // wrapping only the analyzer here left the plan step (and every subplan that inherits it) at 30.
  const analyzers = new Map<string, Analyzer>([['agent-analyzer', agentAnalyzer()]])
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
  shared?: { host: PluginHost; hub: McpHub; config?: ProjectConfig; storage?: Storage; kernel?: Kernel; executorId?: string },
): Promise<DbosPort> {
  const config = shared?.config ?? requireProject(loadConfig())
  const { host, hub } = shared ?? (await buildPlugins(config))
  // reuse the caller's storage (bin passes the kernel's) — one pool, one lifecycle
  const storage = shared?.storage ?? (await openStorage(config.databaseUrl, { projectId: config.projectId, redactEnv: config.redactEnv }))
  const log = storage.events
  // reuse the caller's kernel (bin passes the one wired to its refValidator + analyzers) so
  // task_split's expanded child plans go through the same toolRef/skillRef validation as
  // `orc propose`, and createGroundedTask can resolve its analyzer.
  // approval doors are operator config, so the kernel this port builds tools against must carry
  // the configured set — finalize_plan's refusal text reads it straight off the kernel
  const kernel = shared?.kernel ?? new Kernel(log, host.refValidator, host.analyzers, dbosSend, config.groundedApprovalDoors)
  log.onAppend = e => host.hooks.dispatch(HOOK_NAME.event_appended, e)

  // Startup order (design §8.4): projections FIRST — DBOS recovery may emit events the
  // moment it launches, and they must already be observed. Surreal failure degrades memory
  // (explicit unavailable tools) but never blocks history, execution, or the vault trace.
  const projector = createVaultProjector({ log, config })
  await projector.start()
  let memory: Awaited<ReturnType<typeof createMemory>> | null = null
  let lifecycle: MemoryLifecycle | null = null
  let bindStep: BindStep
  // Read-only probe behind the grounded analyze step's freshness short-circuit (kernel
  // strategies/grounding-freshness.ts). Built only on the memory-healthy path, from the same
  // store + config.dir already in hand here — a runtime with no memory has no grounding notes
  // to reuse, so it stays undefined and the port's branch (guarded on its presence) never fires:
  // exactly today's behavior.
  let groundingSource: ReturnType<typeof createGroundingSource> | undefined
  try {
    memory = await openMemory({ log, config })
    await memory.projector.start()
    const memoryProjector = memory.projector // captured for the lifecycle closure (memory is narrowed non-null here)
    // post-task memory maintenance (auto-consolidation) — a decoupled subscriber, started only in
    // the execution runtime (never in the one-shot CLI memory commands) and stopped at shutdown.
    // `distill` (optional, memoryConsolidateModel) upgrades the note from extractive bullets to a
    // coherent synthesis, off the agent turn budget; absent → extractive. `catchUp` flushes the
    // projection before a consolidation reads the step notes.
    lifecycle = createMemoryLifecycle({ log, store: memory.store, distill: buildDistiller(host.providers, config.memoryConsolidateModel), catchUp: () => memoryProjector.catchUp() })
    await lifecycle.start()
    bindStep = memory.bindStep
    groundingSource = createGroundingSource({ store: memory.store, dir: config.dir })
  } catch (err) {
    const reason = errorMessage(err)
    console.warn(`memory unavailable; continuing in degraded mode: ${reason}`)
    bindStep = () => unavailableStepMemory(reason)
  }

  const port = await createDbosPort({
    storage, config, executorId: shared?.executorId,
    providers: host.providers, executors: host.executors,
    skills: host.skills, tools: hub, groundingSource,
    stepTools: p => {
      const author: MemoryAuthor = { source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role }
      // step role keys the memory role (Task 7): scout/auditor narrow or widen the tool surface
      // + epistemic posture; every other role (e.g. plain worker steps) gets today's verify role.
      const bound = bindStep({
        author,
        step: p.step, taskId: p.taskId, ancestorTaskIds: p.ancestorTaskIds,
        role: memoryRoleFor(p.role), ambientCapture: config.ambientCapture,
      })
      const memoryStore = memory?.store
      // The citing-notes join both audit-side tools ride: candidates for the auditor's
      // heal-or-confirm pass (scoped_changes) and leftovers for the receipt's stillDrifted line
      // (git_commit). Injected here because the kernel may not import plugins/memory — the same
      // seam as the restamp write below. Absent when memory is degraded; the tools say so loudly.
      const knowledge = memory?.knowledge
      const citing = knowledge
        ? (paths: string[]) => notesCiting(knowledge, paths)
        : undefined
      return { memory: bound.memory, tools: [
      ...bound.tools,
      // registration-gated inside the factory (like report_coverage): a scout orients, the plan
      // step decomposes — a scout that splits builds a second, unapproved decomposition.
      ...splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
      // read_annotations only needs the kernel (reads plan_annotated off the log) — unconditional,
      // like splitTool: harmless everywhere, returns an empty list for a task with no annotations.
      readAnnotationsTool({ kernel, p }),
      // report_coverage emits analysis_completed; registration-gated inside the factory to the
      // scout analyze step — a tool that can only ever error must not be visible (scenario-2's
      // verify auditor burned one iteration per attempt calling it).
      ...reportCoverageTool({ kernel, p }),
      // scoped_changes answers "which paths did MY task's steps change?" off the log, so the verify
      // auditor stops reading sibling tasks' completed work out of the SHARED worktree as its own.
      // Registration-gated inside the factory to the auditor VERIFY step (role alone would also hand
      // it to the grounded `plan` step, which shares that role). Read-only, and a FLOOR — never a
      // substitute for the test/typecheck gate, never a reason to dismiss an in-scope defect.
      ...scopedChangesTool({ kernel, p, ...(citing ? { citing } : {}) }),
      // The commit step's tool pair (autoCommit pipeline): preview the task's floor diff, commit,
      // restamp its notes at the new HEAD. Registration is gated TWICE — on config.autoCommit here
      // (the operator's runtime switch, so a stale frozen plan cannot commit after the flag is
      // turned off) and on the kernel-set committer step inside the factory. The restamp write is
      // the store's ordinary re-write (stamps HEAD per write); with memory degraded the tool still
      // commits and says the restamp was skipped.
      ...(config.autoCommit ? commitTool({ kernel, dir: config.dir, p,
        ...(memoryStore ? { restamp: async (note: { id: string; scope: string }, idempotencyKey: string) => { await memoryStore.write({ id: note.id, scope: note.scope }, author, { idempotencyKey }) } } : {}),
        ...(citing ? { citing } : {}),
      }) : []),
      // exec runs operator-allowlisted commands (execAllowlist in .orc/config.json) in the step
      // workspace — the acceptance-gate tool. Empty allowlist = not offered.
      ...execTool({ workspaceDir: p.workspaceDir, allowlist: config.execAllowlist }),
      // finalize_plan reconstructs the plan-note graph from the log (kernel.listPlanNotes), not the
      // memory store — but it's still only offered when memory is healthy: with the memory tools
      // degraded the agent can't author a plan-note graph, so a grounded plan is pointless anyway.
      ...(memory ? [finalizePlanTool({ kernel, config: { maxDepth: config.maxDepth, autoCommit: config.autoCommit }, p })] : []),
      ] }
    },
  })
  await port.launch()
  host.skills.watch() // hot-index during long-lived runs (spec quality scenario: <1s)
  return {
    ...port,
    shutdown: async (opts?: { drain?: boolean }) => {
      await port.shutdown(opts)
      if (lifecycle) await lifecycle.close()
      if (memory) await memory.close()
      await projector.close()
      await host.shutdown() // drains hooks, fires session_shutdown, deactivates extensions, stops the watcher
      await hub.close()
    },
  }
}
