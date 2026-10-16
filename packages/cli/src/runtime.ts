import { AUTHOR_SOURCE, AutoHealMode, CHECKS_EXECUTOR_REF, Door, errorMessage, HookName, KNOWLEDGE_REFUSAL, NO_CHAT, ROLE_SKILL, TERMINAL_TASK_STATUS, type AgentExecutor, type Analyzer, type MemoryAuthor, type TreeStamps } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { configuredProviders } from './providers'
import { agentAnalyzer } from '@orc/analyzer-agent'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { createMemory, treeStamps } from '@orc/memory'
import { AUTO_HEAL_DEBOUNCE_MS, AUTO_SWEEP_TITLE, createAutoHeal, sweepPlanDraft, sweepSpec } from './auto-heal'
import { suspectAtFor } from './suspect-at'
import { openMemory } from './memory-open'
import { knowledgeAccess, openKnowledge } from './knowledge-open'
import { bindStepKnowledge } from '@orc/knowledge-core'
import { cwdAuthor } from './cwd-workspace'
import { createHealTarget } from './heal-target'
import { createVaultProjector } from '@orc/vault-projector'
import { checksExecutor, commitTool, createDbosPort, createPluginHost, dbosSend, execTool, finalizePlanTool, isMcpTrusted, loadConfig, loadTrust, openStorage, planNoteTools, projectorLease, readAnnotationsTool, reportCoverageTool, requireProject, scopedChangesTool, splitTool, taskPlanTool, Kernel, type DbosPort, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'

const AUTO_HEAL_EXECUTOR = 'auto-heal'

// What this supervisor process itself initiates (the commit reactor's sweep): no
// chat answered it, and no terminal typed it.
const SUPERVISOR_ORIGIN = NO_CHAT(Door.supervisor)

export function seedRegistries(config = loadConfig()) {
  const providers = configuredProviders(config)
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor()], [CHECKS_EXECUTOR_REF, checksExecutor()]])
  // The config-driven iteration budget is applied by createGroundedTask, to BOTH template steps —
  // wrapping only the analyzer here left the plan step (and every subplan that inherits it) at 30.
  const analyzers = new Map<string, Analyzer>([['agent-analyzer', agentAnalyzer()]])
  return { providers, executors, analyzers }
}

export async function buildPlugins(config = loadConfig()): Promise<{ host: PluginHost; hub: McpHub }> {
  const host = await createPluginHost(config, seedRegistries(config))
  // point-of-use enforcement (EXTENDING invariant 4): the fingerprint predicate runs against
  // a fresh trust read at spawn time, never a startup snapshot
  const hub = createMcpHub(config.mcpServers, (id, cfg) => isMcpTrusted(loadTrust(config.projectRoot), id, cfg))
  return { host, hub }
}

// Boot is unbounded and blocks every run, and the banner could only ever say "starting": the
// memory projector publishes its own stages, but a drain under the report floor announces nothing
// and the remaining phases (DBOS launch and its recovery of interrupted workflows) had no
// vocabulary at all. Timing every phase is what turns "it hung" into "it is in recovery".
// Exported so callers that open storage themselves (bin.ts's openKernel path, which threads an
// already-open storage into buildRuntime below) can time that open with the SAME instrument and
// hand the result back in as `storageMs` — otherwise that phase is invisible to the boot line.
export const bootPhase = async <T>(label: string, run: () => Promise<T>, into: Array<[string, number]>): Promise<T> => {
  const at = Date.now()
  try { return await run() } finally { into.push([label, Date.now() - at]) }
}

/**
 * The phases list buildRuntime starts from. A caller that opened storage itself (bin.ts, the real
 * `orc serve` path) times it and hands the duration back, so 'storage' leads the line; otherwise
 * buildRuntime times its own open and this starts empty. Pure and exported so the rule is testable
 * without launching DBOS — buildRuntime does not expose `phases`, and the only other observation
 * seam is parsing the printed line, which would pin formatting rather than behaviour.
 */
export const seedPhases = (hasSharedStorage: boolean, storageMs: number | undefined): Array<[string, number]> =>
  hasSharedStorage && storageMs !== undefined ? [['storage', storageMs]] : []

/**
 * Boot-time notice for role skills the index does not hold — one `warn` per missing skill, never a
 * throw.
 *
 * The kernel APPENDS steps a planner never authored and stamps role skills onto steps it did not
 * write: the finish step declares ROLE_SKILL.finisher, the commit step ROLE_SKILL.committer, and
 * the grounded freeze adds ROLE_SKILL.auditor to the verify step. So a checkout whose skills dir
 * was never seeded is already broken before anything runs — but it only said so at proposePlan
 * ("unknown skill 'role-finisher'"), which is the right refusal at the wrong moment: a human is by
 * then already trying to start work.
 *
 * A NOTICE, not a second gate. proposePlan's refusal is the enforcement and stays exactly as it is;
 * a supervisor that would not boot over a skill no plan has asked for yet would be worse than the
 * problem. Pure and exported so the rule is testable without launching DBOS, the same reason
 * seedPhases above is.
 */
export function warnMissingRoleSkills(indexed: string[], skillsDir: string, warn: (message: string) => void): void {
  const have = new Set(indexed)
  for (const skill of Object.values(ROLE_SKILL)) {
    if (!have.has(skill))
      warn(`skill '${skill}' is not in ${skillsDir} — the kernel appends steps that need it; run 'orc init' to seed the shipped skills`)
  }
}

// one supervisor serves every workspace: a note's stamps come from the AUTHOR's checkout, never this process's
export function workspaceStamps(dirOf: (workspaceId: string) => Promise<string | null>): (author: MemoryAuthor) => TreeStamps {
  const stampsIn = async (workspaceId: string): Promise<TreeStamps | null> => {
    const dir = await dirOf(workspaceId)
    return dir === null ? null : treeStamps(dir)
  }
  return author => {
    const stamps = stampsIn(author.workspaceId)
    return {
      revision: async () => (await stamps)?.revision() ?? null,
      blob: async path => (await stamps)?.blob(path) ?? null,
    }
  }
}

export async function buildRuntime(
  shared?: { host: PluginHost; hub: McpHub; config?: ProjectConfig; storage?: Storage; storageMs?: number; kernel?: Kernel; executorId?: string },
): Promise<DbosPort> {
  const config = shared?.config ?? requireProject(loadConfig())
  const { host, hub } = shared ?? (await buildPlugins(config))
  // first thing after the host exists, so the notice lands before the boot line rather than after
  // a minute of projection catch-up — see warnMissingRoleSkills
  warnMissingRoleSkills(host.skills.list().map(s => s.name), config.skillsDir, m => console.warn(m))
  const knowledgeOpening = openKnowledge(config)
  if ('unavailable' in knowledgeOpening && config.knowledge !== null) console.warn(KNOWLEDGE_REFUSAL.unavailable(knowledgeOpening.unavailable))

  // reuse the caller's storage (bin passes the kernel's) — one pool, one lifecycle. When the
  // caller already timed that open (bin.ts's openKernel path), seed the phases list with it so
  // the boot line still names 'storage' instead of the phase silently vanishing whenever
  // shared.storage is provided (which on the real `orc serve` path is always).
  const phases = seedPhases(shared?.storage !== undefined, shared?.storageMs)
  const storage = shared?.storage ?? (await bootPhase('storage', () => openStorage(config.databaseUrl, { projectId: config.projectId, redactEnv: config.redactEnv }), phases))
  const log = storage.events
  // reuse the caller's kernel (bin passes the one wired to its refValidator + analyzers) so
  // task_split's expanded child plans go through the same toolRef/skillRef validation as
  // `orc propose`, and createGroundedTask can resolve its analyzer.
  // approval doors are operator config, so the kernel this port builds tools against must carry
  // the configured set — finalize_plan's refusal text reads it straight off the kernel
  const kernel = shared?.kernel ?? new Kernel(log, host.refValidator, host.analyzers, dbosSend, config.groundedApprovalDoors, config.finishChecks)
  log.onAppend = e => host.hooks.dispatch(HookName.event_appended, e)

  // Startup order: projections FIRST — DBOS recovery may emit events the
  // moment it launches, and they must already be observed. Surreal failure degrades memory
  // but never blocks history, execution, or the vault trace.
  const projector = createVaultProjector({ log, config })
  await bootPhase('vault-projection', () => projector.start(), phases)
  let memory: Awaited<ReturnType<typeof createMemory>> | null = null
  try {
    // The projector LEASE: one live projector per project. Every buildRuntime caller (serve, the
    // graph server, mcp serve) used to run the full standing machinery; three of them against one
    // SurrealDB starved a supervisor boot's drain for 18 minutes. Losers follow the holder's
    // cursor — see createMemoryProjector's follower mode.
    memory = await openMemory({
      log, config, lease: projectorLease(config.databaseUrl, config.projectId),
      stampsFor: workspaceStamps(async id => (await kernel.listWorkspaces({ includeArchived: true })).find(w => w.id === id)?.cwd ?? null),
    })
    const mem = memory // narrowed once here so bootPhase's callback needs no `!`
    await bootPhase('memory-projection', () => mem.projector.start(), phases)
  } catch (err) {
    console.warn(`memory unavailable; continuing in degraded mode: ${errorMessage(err)}`)
  }

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
      // workspaceId comes off `p`, i.e. off the running TASK — NOT from cwdAuthor like every other
      // door here. One supervisor serves every workspace at once, so the process cwd says nothing
      // about where a given step's knowledge belongs; the port reads it from the TaskNode it
      // already folds. See createDbosPort's stepTools.
      // p.origin is the RUNNING STEP's own origin (its run chat), never this process's: the note a
      // step writes belongs to the conversation that step is.
      const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, origin: p.origin, workspaceId: p.workspaceId, taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role }
      const stepAccess = knowledgeAccess(knowledgeOpening, log, p.workspaceDir)
      const stepKnowledge = bindStepKnowledge({
        access: stepAccess, author, p: { stepId: p.stepId, role: p.role, taskId: p.taskId, ancestorTaskIds: p.ancestorTaskIds, step: p.step },
        writesOf: id => kernel.listTaskKnowledgeWrites(id),
      })
      const suspectAt = suspectAtFor(stepAccess, author)
      return { knowledge: stepKnowledge.knowledge, tools: [
      ...stepKnowledge.tools,
      // registration-gated inside the factory (like report_coverage): a scout orients, the plan
      // step decomposes — a scout that splits builds a second, unapproved decomposition.
      ...splitTool({ kernel, config: { approvalPolicy: config.approvalPolicy, maxDepth: config.maxDepth }, p }),
      // read_annotations only needs the kernel (reads plan_annotated off the log) — unconditional,
      // like splitTool: harmless everywhere, returns an empty list for a task with no annotations.
      readAnnotationsTool({ kernel, p }),
      // report_coverage emits analysis_completed; registration-gated inside the factory to the
      // scout analyze step — a tool that can only ever error must not be visible (a verify
      // auditor burned one iteration per attempt calling it).
      ...reportCoverageTool({ kernel, p }),
      // scoped_changes answers "which paths did MY task's steps change?" off the log, so the verify
      // auditor stops reading sibling tasks' completed work out of the SHARED worktree as its own.
      // Registration-gated inside the factory to the auditor VERIFY step (role alone would also hand
      // it to the grounded `plan` step, which shares that role). Read-only, and a FLOOR — never a
      // substitute for the test/typecheck gate, never a reason to dismiss an in-scope defect.
      ...scopedChangesTool({ kernel, p, ...(stepKnowledge.citing && { claimsAt: stepKnowledge.citing }) }),
      ...taskPlanTool({ kernel, p }),
      ...(config.autoCommit ? commitTool({ kernel, dir: p.workspaceDir, p, ...(suspectAt && { suspectAt }) }) : []),
      // exec runs operator-allowlisted commands (execAllowlist in .orc/config.json) in the step
      // workspace — the acceptance-gate tool. Empty allowlist = not offered.
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
  host.skills.watch() // hot-index during long-lived runs (spec quality scenario: <1s)
  return {
    ...port,
    shutdown: async (opts?: { drain?: boolean }) => {
      await port.shutdown(opts)
      autoHeal?.close() // disarm a pending debounce window — a timer firing into closed stores warns, but why let it
      if (memory) await memory.close()
      await projector.close()
      await host.shutdown() // drains hooks, fires session_shutdown, deactivates extensions, stops the watcher
      await hub.close()
    },
  }
}
