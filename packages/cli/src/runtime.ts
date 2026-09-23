import { AUTHOR_SOURCE, AutoHealMode, CHECKS_EXECUTOR_REF, Door, errorMessage, HookName, NO_CHAT, NOTE_TIER, ROLE_SKILL, TERMINAL_TASK_STATUS, type AgentExecutor, type Analyzer, type MemoryAuthor, type TreeStamps } from '@orc/contracts'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { configuredProviders } from './providers'
import { agentAnalyzer } from '@orc/analyzer-agent'
import { createMcpHub, type McpHub } from '@orc/mcp-client'
import { readCorpusDrift, checkoutDrift, CONSOLIDATE_EXECUTOR, createMemory, createMemoryLifecycle, createGroundingSource, decisionDoor, finishTools, memoryVerifyTool, notesCiting, restampToHead, treeStamps, unavailableStepMemory, memoryRoleFor, type BindStep, type MemoryLifecycle } from '@orc/memory'
import { AUTO_HEAL_DEBOUNCE_MS, AUTO_SWEEP_TITLE, createAutoHeal, sweepPlanDraft } from './auto-heal'
import { openMemory } from './memory-open'
import { buildDistiller } from './consolidation-distiller'
import { cwdAuthor, cwdWorkspaceId } from './cwd-workspace'
import { createVaultProjector } from '@orc/vault-projector'
import { checksExecutor, commitTool, createDbosPort, createPluginHost, dbosSend, execTool, finalizePlanTool, isMcpTrusted, loadConfig, loadTrust, openStorage, projectorLease, readAnnotationsTool, reportCoverageTool, requireProject, scopedChangesTool, splitTool, Kernel, type DbosPort, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'

// The `executor` the commit reactor stamps on the notes it restamps. composeAuthor renders it
// verbatim as the note's updatedBy, so this is the name an operator reads in the vault when asking
// who touched a note nobody edited. Declared here, at the composition root that builds the author —
// the reactor itself never sees it.
const AUTO_HEAL_EXECUTOR = 'auto-heal'

// What this supervisor process itself initiates (consolidation, the commit reactor's restamp and
// sweep): no chat answered it, and no terminal typed it.
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
  // (explicit unavailable tools) but never blocks history, execution, or the vault trace.
  const projector = createVaultProjector({ log, config })
  await bootPhase('vault-projection', () => projector.start(), phases)
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
    // The projector LEASE: one live projector per project. Every buildRuntime caller (serve, the
    // graph server, mcp serve) used to run the full standing machinery; three of them against one
    // SurrealDB starved a supervisor boot's drain for 18 minutes. Losers follow the holder's
    // cursor — see createMemoryProjector's follower mode.
    memory = await openMemory({
      log, config, lease: projectorLease(config.databaseUrl, config.projectId),
      stampsFor: workspaceStamps(async id => (await kernel.listWorkspaces({ includeArchived: true })).find(w => w.id === id)?.cwd ?? null),
    })
    const mem = memory // narrowed once here so bootPhase's callback needs no `!` and the closure below reads the same value
    await bootPhase('memory-projection', () => mem.projector.start(), phases)
    const memoryProjector = mem.projector // captured for the lifecycle closure
    // post-task memory maintenance (auto-consolidation) — a decoupled subscriber, started only in
    // the execution runtime (never in the one-shot CLI memory commands) and stopped at shutdown.
    // `distill` (optional, memoryConsolidateModel) upgrades the note from extractive bullets to a
    // coherent synthesis, off the agent turn budget; absent → extractive. `catchUp` flushes the
    // projection before a consolidation reads the step notes.
    // `authorFor` reads the WRITING TASK's workspace, never this cwd — a single cwd-resolved author
    // built once here used to stamp every outcome note under the supervisor's own checkout, so a
    // task that ran in a worktree consolidated as durable knowledge under the wrong workspace while
    // its branch was still unmerged. One supervisor serves every
    // worktree at once, the same reason stepTools below reads its author off the running task
    // rather than off cwdAuthor.
    lifecycle = createMemoryLifecycle({
      log, store: memory.store,
      // Door.supervisor, not cli: this process, not a terminal, decided to consolidate — and no
      // chat, because a lifecycle pass answers no message.
      authorFor: task => ({ source: AUTHOR_SOURCE.agent, executor: CONSOLIDATE_EXECUTOR, workspaceId: task.workspaceId, taskId: task.id, origin: SUPERVISOR_ORIGIN }),
      distill: buildDistiller(host.providers, config.memoryConsolidateModel), catchUp: () => memoryProjector.catchUp(),
    })
    await lifecycle.start()
    bindStep = memory.bindStep
    groundingSource = createGroundingSource({ store: memory.store, dir: config.dir })
  } catch (err) {
    const reason = errorMessage(err)
    console.warn(`memory unavailable; continuing in degraded mode: ${reason}`)
    bindStep = () => unavailableStepMemory(reason)
  }

  // The auto-heal reactor (knowledge provenance plan T2): the router relays commit_recorded here;
  // this side owns the debounce, the free restamp, and — under draft-sweep — DRAFTING (never
  // approving) a heal task. Composed here because it crosses the two domains the kernel keeps
  // apart: the memory store and the kernel. Absent when memory is degraded or the knob is off —
  // the port's callback is optional and the router then leaves commits as records, as before.
  const memoryStore = memory?.store
  const autoHeal = memoryStore && config.autoHeal !== AutoHealMode.off
    ? createAutoHeal({
      mode: config.autoHeal,
      debounceMs: AUTO_HEAL_DEBOUNCE_MS,
      schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) },
      // the reactor's whole frame of reference is config.dir (the restamp and the drift probe both
      // read it), so the restamp writes from the workspace that directory IS — the same lookup the
      // sweep task below makes for its workspaceId.
      // 'agent' named through `executor`, NOT 'cli': nobody typed this. 'cli' means a human at a
      // terminal, and claiming it here would make every reactor-restamped note read `updatedBy: cli`
      // — the same mis-attribution consolidate.ts already carries a comment about.
      restamp: async () => (await restampToHead(memoryStore, config.dir, await cwdAuthor(kernel, config.dir, AUTHOR_SOURCE.agent, SUPERVISOR_ORIGIN, { executor: AUTO_HEAL_EXECUTOR }))).length,
      // FRESH probes per pass: they cache per revision and per path, and the tree this pass must
      // judge is the one the commit just changed — reactor-lifetime probes would answer from the
      // previous commit's diffs
      drifted: async () => (await readCorpusDrift(await memoryStore.list({ tier: NOTE_TIER.semantic }), checkoutDrift(config.dir))).drifted,
      hasOpenSweep: async () => (await kernel.listTasks()).some(t => t.title === AUTO_SWEEP_TITLE && !TERMINAL_TASK_STATUS.has(t.status)),
      draftSweep: async drifted => {
        const task = await kernel.createTask({
          // No originating task to inherit from: auto-heal reacts to a COMMIT, and its whole frame
          // of reference is config.dir (the restamp and the drift probe both read it). So the sweep
          // belongs to the workspace that directory is — the same lookup the `new` command makes.
          workspaceId: await cwdWorkspaceId(kernel, config.dir),
          title: AUTO_SWEEP_TITLE,
          spec: `Auto-drafted by the commit reactor: ${drifted} note(s) still read drifted after the free restamp pass. `
            + 'Call memory_recheck FIRST — it returns the authoritative worklist; never discover candidates via memory_search. '
            + 'For every listed note: memory_read it, check its claims against the current working tree, then re-write it '
            + '(memory_write, SAME id) with corrected content, or with a re-verified claim when its statements still hold. '
            + 'Memory tools and read-only filesystem access only — never edit repository files, never run git commands. '
            + 'Finish by calling memory_recheck again and reporting both counts verbatim. '
            + "If the worklist outgrows your iteration budget, signal outcome 'partial' naming the healed and remaining ids.",
        }, SUPERVISOR_ORIGIN)
        // Proposing is still not approving — the human gate and the spend stay exactly where
        // they were; see sweepPlanDraft for why the draft now carries its plan and lean budget.
        await kernel.proposePlan(task.id, sweepPlanDraft(task.spec, config.memorySweepIterations), SUPERVISOR_ORIGIN)
      },
      warn: m => console.warn(m),
    })
    : null

  const port = await createDbosPort({
    storage, config, executorId: shared?.executorId,
    providers: host.providers, executors: host.executors,
    ...(autoHeal && { onCommitRecorded: async () => { autoHeal.onCommitRecorded() } }),
    skills: host.skills, tools: hub, groundingSource,
    stepTools: p => {
      // workspaceId comes off `p`, i.e. off the running TASK — NOT from cwdAuthor like every other
      // door here. One supervisor serves every workspace at once, so the process cwd says nothing
      // about where a given step's knowledge belongs; the port reads it from the TaskNode it
      // already folds. See createDbosPort's stepTools.
      // p.origin is the RUNNING STEP's own origin (its run chat), never this process's: the note a
      // step writes belongs to the conversation that step is.
      const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, origin: p.origin, workspaceId: p.workspaceId, taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role }
      // step role keys the memory role: scout/auditor narrow or widen the tool surface
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
      // scout analyze step — a tool that can only ever error must not be visible (a verify
      // auditor burned one iteration per attempt calling it).
      ...reportCoverageTool({ kernel, p }),
      // scoped_changes answers "which paths did MY task's steps change?" off the log, so the verify
      // auditor stops reading sibling tasks' completed work out of the SHARED worktree as its own.
      // Registration-gated inside the factory to the auditor VERIFY step (role alone would also hand
      // it to the grounded `plan` step, which shares that role). Read-only, and a FLOOR — never a
      // substitute for the test/typecheck gate, never a reason to dismiss an in-scope defect.
      ...scopedChangesTool({ kernel, p, ...(citing ? { citing } : {}) }),
      // memory_verify is scoped_changes' write-side counterpart on the same step: that tool hands the
      // auditor its heal-or-confirm candidates, this one is how it records a CONFIRM. Gated inside
      // the factory on the identical predicate (auditor role AND the verify step), and only offered
      // when memory is healthy — with no store there is nothing to append to, and a tool that can
      // only ever error is one the model calls anyway, an iteration per attempt.
      ...(memoryStore ? memoryVerifyTool({ store: memoryStore, author, p }) : []),
      // The finish step's pair: what THIS task wrote, and the one write it may make after
      // the human approved the wording. Gated inside the factory on stepMayReconcile — both terms,
      // so only the kernel-appended finish step arms them. `door` is null when memory is degraded so
      // record_decision answers "unavailable" rather than vanishing: a tool that disappears reads to
      // the model as "no decision to record". task_notes reads the LOG, which is up either way.
      ...finishTools({ log, door: memory ? decisionDoor(memory) : null, author, p }),
      // The commit step's tool pair (autoCommit pipeline): preview the task's floor diff, commit,
      // advance the note stamps this task earned at the new HEAD. Registration is gated TWICE — on
      // config.autoCommit here (the operator's runtime switch, so a stale frozen plan cannot commit
      // after the flag is turned off) and on the kernel-set committer step inside the factory. Two
      // stamp writes, because the two stamps mean different things: `restamp` is the store's
      // ordinary re-write (stamps sourceRevision from HEAD per write) for notes the task HEALED;
      // `reverify` is store.verify, which advances the verified stamp of notes a step DECLARED
      // verified and touches nothing the note says. With memory degraded the tool still commits and
      // says which stamp pass was skipped.
      ...(config.autoCommit ? commitTool({ kernel, dir: config.dir, p,
        ...(memoryStore ? {
          restamp: async (note: { id: string; scope: string }, idempotencyKey: string) => { await memoryStore.write({ id: note.id, scope: note.scope }, author, { idempotencyKey }) },
          reverify: async (note: { id: string; scope: string }, idempotencyKey: string) => { await memoryStore.verify(note.id, note.scope, author, { idempotencyKey }) },
        } : {}),
        ...(citing ? { citing } : {}),
      }) : []),
      // exec runs operator-allowlisted commands (execAllowlist in .orc/config.json) in the step
      // workspace — the acceptance-gate tool. Empty allowlist = not offered.
      ...execTool({ workspaceDir: p.workspaceDir, allowlist: config.execAllowlist }),
      // finalize_plan reconstructs the plan-note graph from the log (kernel.listPlanNotes), not the
      // memory store — but it's still only offered when memory is healthy: with the memory tools
      // degraded the agent can't author a plan-note graph, so a grounded plan is pointless anyway.
      ...(memory ? [finalizePlanTool({ kernel, config: { maxDepth: config.maxDepth, autoCommit: config.autoCommit, finishChecks: config.finishChecks }, p })] : []),
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
      if (lifecycle) await lifecycle.close()
      if (memory) await memory.close()
      await projector.close()
      await host.shutdown() // drains hooks, fires session_shutdown, deactivates extensions, stops the watcher
      await hub.close()
    },
  }
}
