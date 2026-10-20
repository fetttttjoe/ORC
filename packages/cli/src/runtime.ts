import { AUTHOR_SOURCE, AutoHealMode, CHECKS_EXECUTOR_REF, Door, HookName, KNOWLEDGE_REFUSAL, NO_CHAT, ROLE_SKILL, TERMINAL_TASK_STATUS, type AgentExecutor, type Analyzer, stepAuthor } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { configuredProviders } from './providers'
import { agentAnalyzer } from '@orc/analyzer-agent'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { AUTO_HEAL_DEBOUNCE_MS, AUTO_SWEEP_TITLE, createAutoHeal, sweepPlanDraft, sweepSpec } from './auto-heal'
import { suspectAtFor } from './suspect-at'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import { bindStepKnowledge } from '@orc/knowledge-core'
import { cwdAuthor } from './cwd-workspace'
import { createHealTarget } from './heal-target'
import { createVaultProjector } from '@orc/vault-projector'
import { checksExecutor, commitTool, createDbosPort, createPluginHost, dbosSend, execTool, finalizePlanTool, isMcpTrusted, loadConfig, loadTrust, openStorage, planNoteTools, readAnnotationsTool, reportCoverageTool, requireProject, scopedChangesTool, splitTool, taskPlanTool, Kernel, type DbosPort, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'

const AUTO_HEAL_EXECUTOR = 'auto-heal'

// what this supervisor itself initiates (the commit reactor's sweep): no chat, no terminal
const SUPERVISOR_ORIGIN = NO_CHAT(Door.supervisor)

export function seedRegistries(config = loadConfig()) {
  const providers = configuredProviders(config)
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor()], [CHECKS_EXECUTOR_REF, checksExecutor()]])
  // the iteration budget is applied by createGroundedTask to BOTH template steps, not here
  const analyzers = new Map<string, Analyzer>([['agent-analyzer', agentAnalyzer()]])
  return { providers, executors, analyzers }
}

export async function buildPlugins(config = loadConfig()): Promise<{ host: PluginHost; hub: McpHub }> {
  const host = await createPluginHost(config, seedRegistries(config))
  // point-of-use: the fingerprint predicate runs against a fresh trust read at spawn time
  const hub = createMcpHub(config.mcpServers, (id, cfg) => isMcpTrusted(loadTrust(config.projectRoot), id, cfg))
  return { host, hub }
}

// exported so bin.ts's openKernel path can time its storage open with the same instrument
export const bootPhase = async <T>(label: string, run: () => Promise<T>, into: Array<[string, number]>): Promise<T> => {
  const at = Date.now()
  try { return await run() } finally { into.push([label, Date.now() - at]) }
}

/** The phases buildRuntime starts from: a caller that timed its own storage open leads the line. */
export const seedPhases = (hasSharedStorage: boolean, storageMs: number | undefined): Array<[string, number]> =>
  hasSharedStorage && storageMs !== undefined ? [['storage', storageMs]] : []

/** One `warn` per role skill the index lacks, never a throw: proposePlan's refusal is the gate. */
export function warnMissingRoleSkills(indexed: string[], skillsDir: string, warn: (message: string) => void): void {
  const have = new Set(indexed)
  for (const skill of Object.values(ROLE_SKILL)) {
    if (!have.has(skill))
      warn(`skill '${skill}' is not in ${skillsDir} — the kernel appends steps that need it; run 'orc init' to seed the shipped skills`)
  }
}

export async function buildRuntime(
  shared?: { host: PluginHost; hub: McpHub; config?: ProjectConfig; storage?: Storage; storageMs?: number; kernel?: Kernel; executorId?: string },
): Promise<DbosPort> {
  const config = shared?.config ?? requireProject(loadConfig())
  const { host, hub } = shared ?? (await buildPlugins(config))
  // first thing after the host exists, so the notice lands before the boot line
  warnMissingRoleSkills(host.skills.list().map(s => s.name), config.skillsDir, m => console.warn(m))
  const knowledgeOpening = openKnowledge(config)
  if ('unavailable' in knowledgeOpening && config.knowledge !== null) console.warn(KNOWLEDGE_REFUSAL.unavailable(knowledgeOpening.unavailable))

  // reuse the caller's storage: one pool, one lifecycle; seed the phases with its timed open
  const phases = seedPhases(shared?.storage !== undefined, shared?.storageMs)
  const storage = shared?.storage ?? (await bootPhase('storage', () => openStorage(config.databaseUrl, { projectId: config.projectId, redactEnv: config.redactEnv }), phases))
  const log = storage.events
  // reuse the caller's kernel: it carries the refValidator, analyzers and configured approval doors
  const kernel = shared?.kernel ?? new Kernel(log, host.refValidator, host.analyzers, dbosSend, config.groundedApprovalDoors, config.finishChecks)
  log.onAppend = e => host.hooks.dispatch(HookName.event_appended, e)

  // the vault projection starts FIRST: DBOS recovery may emit events the moment it launches
  const projector = createVaultProjector({ log, config })
  await bootPhase('vault-projection', () => projector.start(), phases)

  const healTarget = createHealTarget({ kernel, dir: config.dir })

  const autoHeal = !('unavailable' in knowledgeOpening) && config.autoHeal !== AutoHealMode.off
    ? createAutoHeal({
      mode: config.autoHeal,
      debounceMs: AUTO_HEAL_DEBOUNCE_MS,
      schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
      suspects: async workspaceId => {
        const target = await healTarget(workspaceId)
        const access = knowledgeAccess(knowledgeOpening, log, target.dir)
        if ('unavailable' in access) throw new Error(access.unavailable)
        const author = { source: AUTHOR_SOURCE.agent, origin: SUPERVISOR_ORIGIN, workspaceId: target.id, executor: AUTO_HEAL_EXECUTOR }
        return access.port.drift({ author, idempotencyKey: null })
      },
      hasOpenSweep: async workspaceId => {
        const { id } = await healTarget(workspaceId)
        return (await kernel.listTasks()).some(t => t.title === AUTO_SWEEP_TITLE && t.workspaceId === id && !TERMINAL_TASK_STATUS.has(t.status))
      },
      draftSweep: async (workspaceId, suspects) => {
        const task = await kernel.createTask({
          workspaceId: (await healTarget(workspaceId)).id,
          title: AUTO_SWEEP_TITLE,
          spec: sweepSpec(suspects),
        }, SUPERVISOR_ORIGIN)
        await kernel.proposePlan(task.id, sweepPlanDraft(task.spec, config.autoHealIterations), SUPERVISOR_ORIGIN)
      },
      warn: m => console.warn(m),
    })
    : null

  const port = await createDbosPort({
    storage, config, executorId: shared?.executorId,
    providers: host.providers, executors: host.executors,
    ...(autoHeal && { onCommitRecorded: async payload => { autoHeal.onCommitRecorded(payload.workspaceId) } }),
    skills: host.skills, tools: hub,
    stepTools: p => {
      // workspaceId comes off the running TASK, not cwdAuthor: one supervisor serves every workspace
      const author = stepAuthor(p)
      const stepAccess = knowledgeAccess(knowledgeOpening, log, p.workspaceDir)
      const stepKnowledge = bindStepKnowledge({
        access: stepAccess, author, p: { stepId: p.stepId, role: p.role, taskId: p.taskId, ancestorTaskIds: p.ancestorTaskIds, step: p.step },
        writesOf: id => kernel.listTaskKnowledgeWrites(id),
      })
      const suspectAt = suspectAtFor(stepAccess, author)
      return { knowledge: stepKnowledge.knowledge, tools: [
      ...stepKnowledge.tools,
      // registration-gated in the factory: a scout that splits builds a second, unapproved plan
      ...splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
      // unconditional: returns an empty list for a task with no annotations
      readAnnotationsTool({ kernel, p }),
      // registration-gated to the scout analyze step: a tool that can only error gets called anyway
      ...reportCoverageTool({ kernel, p }),
      // scoped_changes is registration-gated to the verify and finish steps; a floor, never the gate
      ...scopedChangesTool({ kernel, p, ...(stepKnowledge.citing && { claimsAt: stepKnowledge.citing }) }),
      ...taskPlanTool({ kernel, p }),
      ...(config.autoCommit ? commitTool({ kernel, dir: p.workspaceDir, p, ...(suspectAt && { suspectAt }) }) : []),
      // exec runs operator-allowlisted commands in the step workspace; an empty allowlist is not offered
      ...execTool({ workspaceDir: p.workspaceDir, allowlist: config.execAllowlist }),
      // the plan step's authoring surface; both factories register for that step alone
      ...planNoteTools({ kernel, p }),
      ...finalizePlanTool({ kernel, config: { maxDepth: config.maxDepth, autoCommit: config.autoCommit, finishChecks: config.finishChecks }, p }),
      ] }
    },
  })
  await bootPhase('dbos-launch', () => port.launch(), phases)
  // one line, at the moment an operator is guaranteed to be reading: which phase owned the boot
  console.log(`orc serve: boot ${phases.map(([l, ms]) => `${l} ${ms}ms`).join(' · ')}`)
  host.skills.watch() // hot-index during long-lived runs
  return {
    ...port,
    shutdown: async (opts?: { drain?: boolean }) => {
      await port.shutdown(opts)
      autoHeal?.close() // disarm a pending debounce window — a timer firing into closed stores warns, but why let it
      await projector.close()
      await host.shutdown() // drains hooks, fires session_shutdown, deactivates extensions, stops the watcher
      await hub.close()
    },
  }
}
