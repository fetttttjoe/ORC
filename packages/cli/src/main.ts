import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import { AUTHOR_SOURCE, Door, NO_CHAT, EventKind, PlanDraft, RunOutcome, STRATEGY, TASK_STATUS, type Analyzer, type EventRecord, type ExecutionPort, type Plan, type TaskNode, type WorkspaceWithHealth, formatModelRate } from '@orc/contracts'
import { openStorage, Kernel, atomicWriteFileSync, listProjectIds, claimSlot, fold, gatedChildren, liveSupervisors, orphanTasks, staleSupervisors, grantExtensionTrust, grantMcpTrust, initializeProject, isExtensionTrusted, isMcpTrusted, loadConfig, loadTrust, migrateDatabase, requireProject, runtimeLockHeld, stepUsage, subtreeUsage, tasksByWorkspace, taskUsage, type EventLog, type OrcConfig, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'
import { createVaultProjector, parsePlanFile } from '@orc/vault-projector'
import { DEFAULT_TEMPLATE_MODEL, singleStepDraft } from './plan-template'
import { seedShippedSkills } from './shipped-skills'
import { seedRegistries, buildRuntime } from './runtime'
import { runSupervisor, startBootHeartbeat, supervisorHealth } from './serve'
import { ensureSupervisor, SUPERVISOR_MODE, type SupervisorMode } from './supervisor-client'
import { isLanguageModel } from './model-guard'
import { assertDrivable, assertRetryable, buildModelDiscovery, buildOrcActions } from './actions'
import { cwdAuthor, cwdWorkspaceId, findCwdWorkspace } from './cwd-workspace'
import { enumArg } from './enum-arg'
import { parseNonNegativeInteger, parsePositiveInteger } from './int-arg'
import { derivedPlanBlock, renderPlanHuman } from './plan-render'
import { adrCommand } from './adr-commands'
import { knowledgeCommand } from './knowledge-commands'
import { KNOWLEDGE_HEALTH_TTL_MS, knowledgeHealthOf } from './knowledge-health-of'
import { wsCommand, WS_NEEDS_PROJECT } from './ws-commands'
import { briefCommand } from './brief-commands'
import { knowledgeHealthLine } from './knowledge-health-line'
import { memoizeFor } from './memoize-for'
import { buildWorkspaceOps, requireLiveWorkspace, type WorkspaceConfig } from './workspace-ops'
import type { WorkspaceDoor } from './door-kernel'
import { listWorkspaceHealth } from './workspace-health'
import { serveLogFile, servePidFile } from './serve-paths'
import { CommandFailure, DATABASE_UNREACHABLE, EXIT_CODE } from './exit'
import { formatUsageLine } from './usage-render'
import { watchSubtree, type TailResult } from './watch'
import { watchStream } from './stream-watch'
import { untilInterrupted } from './until-interrupted'
import type { PlanSource } from '@orc/ui-core'

// Every command in this file enters through the terminal, so every event it causes is stamped with
// the same Origin — identity (which door), never authority: no handler below branches on it.
const CLI_ORIGIN = NO_CHAT(Door.cli)

function buildCopilotConfig(
  discovery: ReturnType<typeof buildModelDiscovery>,
  listWorkspaces: () => Promise<WorkspaceWithHealth[]>,
  resolveWorkspace: (taskId: string | null) => Promise<string | null>,
) {
  return {
    resolveWorkspace,
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    // one flagless core, shared with the MCP door: it discovers, bounded per provider
    listModels: () => discovery.listModels(),
    listWorkspaces,
    resolveModel: (ref: string) => {
      const { p, modelId } = discovery.providerFor(ref)
      const model = p.languageModel(modelId)
      if (!isLanguageModel(model)) throw new Error(`provider '${ref}' returned a non-language-model`)
      return model
    },
    price: discovery.price,
  }
}
import type { McpHub } from '@orc/mcp-client'

// config is the caller's: doors and finishChecks are operator config this factory must not invent
export async function openKernel(
  url: string,
  opts: {
    projectId?: string
    redactEnv?: string[]
    refValidator?: (plan: Plan) => Promise<string[]>
    analyzers?: Map<string, Analyzer>
    send?: (workflowId: string, message: string, topic: string, idempotencyKey: string) => Promise<void>
    onAppend?: (e: EventRecord) => void
    config: OrcConfig
  },
): Promise<{ kernel: Kernel; log: EventLog; storage: Storage }> {
  const { config } = opts
  const projectId = opts.projectId ?? requireProject(config).projectId
  const storage = await openStorage(url, { projectId, redactEnv: opts.redactEnv })
  const log = storage.events
  if (opts.onAppend) log.onAppend = opts.onAppend
  return { kernel: new Kernel(log, opts.refValidator, opts.analyzers, opts.send, config.groundedApprovalDoors, config.finishChecks), log, storage }
}

// `orc init` must work before Postgres/plugins exist, so it gets a standalone entry
// (bin.ts) and the same command inside buildProgram for help/unit visibility.
//
// IDEMPOTENT, and deliberately so: seeding runs on EVERY invocation and only the identity mint is
// guarded. Before this, an existing project could not receive a newly shipped skill at all — init
// refused outright, and `--force` minted a fresh projectId, orphaning every task, note and event in
// the log just to top up a directory. `orc init` is now the answer to "I pulled a release that
// ships a new role skill". The kernel's own refusal (initializeProject) is untouched: minting a
// second identity over a live one still needs --force.
export function initCommand(dir?: string): Command {
  return new Command('init')
    .description('seed the shipped skills and initialize project identity (.orc/identity.json — local, never committed)')
    .requiredOption('--name <name>', 'project name')
    .option('--force', 'mint a new identity for a deliberate fork of an existing project')
    .action((opts: { name: string; force?: boolean }) => {
      const projectDir = dir ?? process.cwd()
      const config = loadConfig(projectDir)
      const seeded = seedShippedSkills(config.skillsDir)
      const skillLine = seeded.length > 0 ? `seeded: ${seeded.join(', ')}` : 'skills up to date'
      // an identity already here and no --force: report what is, report what the seed did, exit 0
      if (config.projectId !== null && config.projectName !== null && !opts.force) {
        console.log(`project already initialized as '${config.projectName}' (${config.projectId}) in ${config.projectRoot}`)
        console.log(skillLine)
        return
      }
      const identity = initializeProject(projectDir, opts.name, { force: opts.force })
      console.log(`initialized project '${identity.projectName}' (${identity.projectId}) in ${identity.projectRoot}`)
      console.log(skillLine)
    })
}

export async function runInit(args: string[], dir?: string): Promise<void> {
  await initCommand(dir).parseAsync(args, { from: 'user' })
}

export function databaseCommand(dir?: string): Command {
  const database = new Command('db').description('database schema')
  database.command('migrate')
    .description('apply committed database migrations')
    .action(async () => {
      await migrateDatabase(loadConfig(dir).databaseUrl)
      console.log('database migrated')
    })
  return database
}

export async function runMigrate(args: string[], dir?: string): Promise<void> {
  await databaseCommand(dir).parseAsync(args, { from: 'user' })
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new InvalidArgumentError(`must be a positive amount, got '${value}'`)
  return parsed
}

// An AUTHORED draft — the door's parsing job. The template arm lives in OrcActions.propose, so
// every door validates one draft the same way.
function authoredDraft(opts: { file?: string; fromVault?: boolean }, taskId: string, config?: OrcConfig): PlanDraft {
  // Two sources for one draft. The vault arm used to win silently, so an operator who passed both
  // watched their authored --file draft be ignored and the vault markdown applied under its name.
  if (opts.fromVault && opts.file)
    throw new Error('--file and --from-vault name two different drafts — pass exactly one')
  if (opts.fromVault) {
    if (!config) throw new Error('--from-vault is unavailable in this context')
    const dir = path.join(config.vaultDir, 'tasks', taskId)
    const latest = readdirSync(dir)
      .filter(f => /^plan-v\d+\.md$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1)
    if (!latest) throw new Error(`no plan file in ${dir} — run 'orc vault render ${taskId}' first`)
    return parsePlanFile(readFileSync(path.join(dir, latest), 'utf8'))
  }
  if (!opts.file) throw new Error('no authored draft: pass --file or --from-vault')
  return PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8')))
}

// Re-exported (not just imported) so existing callers of these two paths keep resolving them
// through main.ts — see serve-paths.ts for why they live there rather than here.
export { serveLogFile, servePidFile }

// Start a supervisor that survives this command. Detached on purpose: a supervisor left in the
// CLI's process group would take the ctrl-c meant for the watch, which is the exact behaviour this
// phase removes. node's spawn is what carries `detached` (setsid); Bun.spawn has no equivalent.
function spawnSupervisor(config: ProjectConfig): void {
  const logPath = serveLogFile(config)
  mkdirSync(path.dirname(logPath), { recursive: true })
  const log = openSync(logPath, 'a')
  try {
    // argv[1] is this CLI's own entry point — re-running it is what makes the child the same orc,
    // whether it was reached through the bin shim, `bun run`, or a linked node_modules/.bin.
    // cwd stays config.dir (the checkout this command runs in), not projectRoot: the supervisor
    // child's own loadConfig then defaults its run workspace to the tree being worked, which is
    // the wanted behaviour until a run's cwd is resolved from a recorded workspace instead of the process cwd.
    spawn(process.execPath, [process.argv[1] ?? '', 'serve'], {
      cwd: config.dir, detached: true, stdio: ['ignore', log, log],
    }).unref()
  } finally {
    closeSync(log) // the child holds its own dup of the fd
  }
}

export function buildProgram(
  // null only for bin.ts's --help/-h path: commander prints help and exits before any action
  // runs, so no handler below ever actually calls requireKernel() in that mode — but the type says
  // so honestly instead of a `{} as Kernel` handed to every command as if it could serve one.
  kernel: Kernel | null,
  portFactory?: () => Promise<ExecutionPort>,
  plugin?: { host: PluginHost; hub: McpHub; config: ProjectConfig; log: EventLog; storage?: Storage },
  // set when the project database could not be reached at boot: no kernel and no log, and anything that needs either fails with this error
  unreachable?: { config: ProjectConfig; error: unknown },
): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')
  program.option('--no-daemon', 'hold the execution runtime in this command instead of a background supervisor (tests, CI, benchmarks)')
  program.addCommand(initCommand(plugin?.config.dir))
  program.addCommand(databaseCommand(plugin?.config.dir))

  const noProject = (message: string): unknown => (unreachable ? unreachable.error : new Error(message))

  const needPlugin = () => {
    if (!plugin) throw noProject('plugin commands are unavailable in this context')
    return plugin
  }

  // same shape as needPlugin: every command handler that touches the kernel goes through this,
  // so a handler that somehow ran under --help fails with an actionable message instead of a bare
  // null-reference TypeError.
  const requireKernel = (): Kernel => {
    if (!kernel) throw noProject('this command needs a project context (only --help works without one)')
    return kernel
  }

  const wsProject = (): { config: ProjectConfig; log: EventLog } => {
    if (!plugin) throw noProject(WS_NEEDS_PROJECT)
    return { config: plugin.config, log: plugin.log }
  }
  const wsConfig = (): WorkspaceConfig => wsProject().config
  let wsDoor: WorkspaceDoor | null = null
  const requireWsDoor = (): WorkspaceDoor => (wsDoor ??= {
    workspaces: buildWorkspaceOps({ kernel: requireKernel(), config: wsConfig }),
    reads: requireKernel(),
    config: wsConfig,
    listWorkspaces: includeArchived => listWorkspaceHealth({ ...wsProject(), includeArchived }),
  })

  // Placed after requireKernel rather than beside the init/db addCommands above: the deps object
  // reads that binding immediately, so calling wsCommand up there would hit its temporal dead zone.
  program.addCommand(wsCommand({ requireDoor: requireWsDoor }))
  program.addCommand(adrCommand({ requireKernel, noProject, ...(plugin && { project: { config: plugin.config, log: plugin.log } }) }))
  const knowledgeProject = plugin ? { config: plugin.config, log: plugin.log }
    : unreachable && { config: unreachable.config, logUnreachable: { reason: DATABASE_UNREACHABLE(unreachable.config.databaseUrl), error: unreachable.error } }
  program.addCommand(knowledgeCommand({ requireKernel, noProject, ...(knowledgeProject && { project: knowledgeProject }) }))
  program.addCommand(briefCommand({ noProject, ...(plugin && { project: { config: plugin.config, log: plugin.log } }) }))

  // Discovery-backed model validation rejects invented refs at creation time on every surface;
  // declared here (not at the actions site below) so the `plan` command's rate line can reach it.
  const discovery = plugin ? buildModelDiscovery(plugin.config, { log: plugin.log, origin: CLI_ORIGIN }) : undefined

  program
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .option('--strategy <s>', `bootstrap strategy ('${STRATEGY.groundedPlan}' starts an analyze→plan conversation instead of a bare draft task)`)
    .option('--model <ref>', `model for the grounded-plan analyze/plan steps (required with --strategy ${STRATEGY.groundedPlan})`)
    .option('--analyzer <ref>', 'analyzer for the grounded-plan analyze step', 'agent-analyzer')
    // TaskNode.budgetUSD has been enforced by the kernel all along (proposeSplit debits a child's
    // budget from the parent's remaining), but nothing could SET it — a spend cap no caller can
    // turn on is a cap that does not exist.
    .option('--budget <usd>', 'cap total spend for this task and its subtree', parsePositiveNumber)
    .option('--workspace <id>', 'workspace for this task (default: the workspace this directory is)')
    .action(async (title: string, opts: { spec: string; parent?: string; strategy?: string; model?: string; analyzer: string; budget?: number; workspace?: string }) => {
      if (opts.strategy !== undefined && !(Object.values(STRATEGY) as string[]).includes(opts.strategy))
        throw new Error(`unknown --strategy '${opts.strategy}' — valid strategies: ${Object.values(STRATEGY).join(', ')}`)
      // A ROOT task belongs to the checkout the operator typed the command in; a CHILD belongs to
      // its parent's workspace, so `--parent` hands the decision to the kernel (createTaskIn's
      // inheritance) by leaving this undefined. Re-homing a child to wherever the command happened
      // to be typed would let ONE subtree straddle two working directories — exactly what
      // proposeSplit's inherited workspaceId exists to prevent. An explicit --workspace still wins
      // over both, for the deliberate re-home.
      // Named outright, so it is checked outright: the kernel accepts a task in an archived
      // workspace (a merged workspace's subtree must keep growing) and only a caller that typed the
      // id can be told it named finished business. The inherited and cwd-derived arms below are not
      // checked — one subtree must not straddle two checkouts.
      if (opts.strategy === STRATEGY.groundedPlan && !opts.model)
        throw new Error(`--model is required with --strategy ${STRATEGY.groundedPlan}`)
      const grounded = opts.strategy === STRATEGY.groundedPlan && opts.model
        // cwd null: the task's own workspace is the checkout it runs in, never this terminal's
        ? { grounded: { modelRef: opts.model, analyzerRef: opts.analyzer, cwd: null } }
        : {}
      const { taskId } = await actions().newTask({
        title, spec: opts.spec, parentId: opts.parent, budgetUSD: opts.budget ?? null,
        ...(opts.workspace !== undefined && { workspaceId: opts.workspace }), ...grounded,
      }, CLI_ORIGIN)
      console.log(taskId)
      // the grounded arm's run is already requested by the action (its template is policy-approved
      // — the real gate is the conversational one inside the plan step); this only watches it
      if (opts.strategy === STRATEGY.groundedPlan) await watchFrom(taskId, undefined)
    })

  const requireTask = async (taskId: string) => {
    const task = await requireKernel().getTask(taskId)
    if (!task) throw new Error(`no task '${taskId}'`)
    return task
  }
  // The door's half of a plan stamp: --file/--from-vault is a draft to PARSE, a bare invocation is
  // the action's own template. Nothing here decides what a plan is.
  const planSource = (taskId: string, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }): PlanSource =>
    opts.file || opts.fromVault
      ? { draft: authoredDraft(opts, taskId, plugin?.config) }
      : { template: { modelRef: opts.model, skillRefs: opts.skill ?? [] } }
  const planAction = <R extends { version: number }>(apply: (taskId: string, plan: PlanSource) => Promise<R>, describe: (result: R) => string) =>
    async (taskId: string, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }) => {
      const result = await apply(taskId, planSource(taskId, opts))
      console.log(`plan v${result.version} ${describe(result)} — review with: orc plan ${taskId}`)
    }

  program
    .command('propose <taskId>')
    .description('stamp a plan for review (default: a single-step template of your spec — NO model call; --file supplies an authored multi-step draft)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', DEFAULT_TEMPLATE_MODEL)
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .action(planAction((id, plan) => actions().propose(id, plan, CLI_ORIGIN), r => `proposed (${r.steps} steps)`))

  program
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', DEFAULT_TEMPLATE_MODEL)
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .option('--from-vault', 'read the edited plan markdown from the vault')
    .action(planAction((id, plan) => actions().edit(id, plan, CLI_ORIGIN), () => 'edited'))

  // per-MTok rate for the gate: the human weighs spend BEFORE approving. Best-effort —
  // no provider/discovery (read-only context, unknown ref) renders without a rate.
  const rateFor = (ref: string): string | null => {
    if (!discovery) return null
    try {
      const { p, modelId } = discovery.providerFor(ref)
      return formatModelRate(p.costs[modelId] ?? p.costs['*'])
    } catch { return null }
  }

  program
    .command('plan <taskId>')
    .description('show a plan for review (latest by default; --json for the raw draft)')
    .option('--version <n>', 'plan version', parseNonNegativeInteger)
    .option('--json', 'raw plan JSON (scripts; the full field set)')
    .action(async (taskId: string, opts: { version?: number; json?: boolean }) => {
      const plan = await requireKernel().getPlan(taskId, opts.version)
      if (!plan) throw new Error(`no plan for task '${taskId}'`)
      if (opts.json) { console.log(JSON.stringify(plan, null, 2)); return }
      console.log(renderPlanHuman(plan, rateFor))
      console.log(`approve: orc approve ${taskId} · raw: orc plan ${taskId} --json`)
    })

  program
    .command('approve <taskId>')
    .description('approve the latest plan (the human gate)')
    .option('--version <n>', 'expected version (fails if stale)', parseNonNegativeInteger)
    .action(async (taskId: string, opts: { version?: number }) => {
      const root = await rootOf(taskId)
      const { version } = await actions().approve(taskId, { ...(opts.version !== undefined && { version: opts.version }) }, CLI_ORIGIN)
      console.log(`plan v${version} approved`)
      if (root === taskId) return
      // Watch the ROOT, because that is the run whose join is waiting — and only while it is
      // actually running: approving is never itself a decision to start a run.
      if ((await requireKernel().getTask(root))?.status !== TASK_STATUS.running) return
      console.log(`watching the run at ${root}`)
      await report(await watchSubtree(requireKernel(), root), root)
    })

  program
    .command('plan-note <taskId> <noteId> <text>')
    .description('annotate a plan-note (grounded-plan) — the plan-authoring agent reads it on its next revise')
    .option('--ref <ids...>', 'related plan-note ids')
    .action(async (taskId: string, noteId: string, text: string, opts: { ref?: string[] }) => {
      await actions().annotate(taskId, noteId, text, opts.ref ?? [], CLI_ORIGIN)
      console.log(`noted on '${noteId}'`)
    })

  program
    .command('reply <taskId> <text>')
    .description("answer a task's open feedback question (e.g. 'orc reply <taskId> approve'), then drive the resumed run")
    .action(async (taskId: string, text: string) => {
      // Answering only UNBLOCKS the step — something still has to carry the answer into the parked
      // workflow (the supervisor's router does, off feedback_provided) and then keep executing. A
      // reply from a fresh terminal used to leave the answer sitting durable in DBOS's notification
      // table with nobody to act on it; the action ensures a supervisor first, which is what makes
      // this command's promise true. No run is requested: the run already exists, parked.
      // The topic is READ before the answer closes the question — presentation the door owes the
      // human ('answered feedback:<topic>'), not a second copy of the reply rule.
      const topic = (await requireKernel().openFeedback(taskId))?.topic
      const { answered } = await actions().reply(taskId, text, undefined, CLI_ORIGIN)
      if (!answered) {
        console.log(`no open feedback question for task '${taskId}'`)
        return
      }
      console.log(`answered feedback:${topic}`)
      // the answered task may itself be a split child — the join it unblocks belongs to an
      // ancestor, so the cost line sums from the ROOT of the tree, not from this task alone
      await report(await watchSubtree(requireKernel(), taskId), await rootOf(taskId))
    })

  program
    .command('plan-revise <taskId> <text>')
    .description('targeted re-plan (grounded-plan): annotate each --scope note with <text>, then resume the plan agent to revise just those notes')
    .requiredOption('--scope <ids...>', 'plan-note ids to revise (only they and the subplans they list change; every other note stays byte-stable)')
    .action(async (taskId: string, text: string, opts: { scope: string[] }) => {
      // annotate-and-resume sugar over `plan-note … && reply`: queue the same change onto each scoped
      // note, then wake the parked plan step so it reads them (read_annotations) and revises in place.
      const { topic } = await actions().revise(taskId, text, opts.scope, CLI_ORIGIN)
      console.log(topic
        ? `revised ${opts.scope.join(', ')} — answered feedback:${topic}`
        : `annotated ${opts.scope.join(', ')} — no open feedback to resume (the agent reads them on its next revise)`)
    })

  program
    .command('purge <projectName>')
    .description("cancel running work and delete the named project's events and operations — identity and knowledge files stay (clean slate for re-testing)")
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project history')
    .action(async (projectName: string) => {
      // The target comes from whatever .orc/config.json the cwd resolves to, so a script that
      // drifts into another directory purges a project it never meant to touch — that is not
      // hypothetical, it destroyed a live run's history. Naming the project makes the caller
      // state its intent, and a drifted cwd fails loudly instead of deleting the wrong history.
      const cfg = plugin?.config
      if (!cfg?.projectName) throw noProject('purging needs a project context')
      const actual = cfg.projectName
      if (projectName !== actual)
        throw new Error(`refusing: this directory is project '${actual}' (${cfg.dir}), not '${projectName}'`)
      const r = await actions().purgeProject(CLI_ORIGIN)
      console.log(`purged ${r.events} event(s), ${r.operations} operation(s) from '${actual}'`)
      for (const w of r.warnings) console.log(`warning: ${w}`)
    })

  program
    .command('projects')
    .description('every project this database holds, including ones whose identity file is gone')
    .action(async () => {
      // The CLI had no way to SEE a project other than the cwd's, which is how four abandoned
      // ones accumulated 1128 events nobody could name or reach: an identity file is per-directory
      // and `orc init` overwrites it, so a re-inited directory orphans its predecessor outright.
      // The web UI listed them all along; this is the same list, from the same primitive.
      // A foreign project's name is not resolved: that would read every project's log for a label.
      const cfg = plugin?.config
      if (!cfg) throw noProject('listing projects needs a project context')
      const ids = await listProjectIds(cfg.databaseUrl)
      if (ids.length === 0) return console.log('_no projects_')
      for (const id of ids)
        console.log(id === cfg.projectId ? `${id}\t${cfg.projectName}\t<- this directory` : `${id}\t(no identity here — delete with: orc delete --id ${id} --yes)`)
    })

  program
    .command('delete [projectName]')
    .description("delete a project entirely — history and durable-execution state (purge keeps the chat; this does not)")
    .option('--id <projectId>', 'delete a FOREIGN project by id — for one whose identity file is gone, so no name exists to confirm against (see: orc projects)')
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project')
    .action(async (projectName: string | undefined, opts: { id?: string }) => {
      const cfg = plugin?.config
      if (!cfg) throw noProject('deleting a project needs a project context')
      if (opts.id !== undefined) {
        // An orphan has no name to confirm against — the id IS the confirmation, and it must not
        // be the project you are standing in, which `delete <name>` already covers with a check
        // that can actually verify what it is deleting.
        if (projectName !== undefined)
          throw new Error('pass a name or --id, not both: a name confirms the cwd project, --id targets a foreign one')
        if (opts.id === cfg.projectId)
          throw new Error(`refusing: ${opts.id} is THIS directory's project — delete it by name (orc delete ${cfg.projectName} --yes) so the name confirms the target`)
        const r = await actions().deleteProject(opts.id, CLI_ORIGIN)
        console.log(`deleted ${opts.id}: ${r.events} event(s), ${r.operations} operation(s)`)
        for (const w of r.warnings) console.log(`warning: ${w}`)
        return
      }
      // named for the same reason purge is: the target comes from the cwd's config, so a script
      // in the wrong directory would otherwise delete a project it never meant to touch
      if (!cfg.projectName) throw noProject('deleting a project needs a project context')
      const actual = cfg.projectName
      if (projectName !== actual)
        throw new Error(`refusing: this directory is project '${actual}' (${cfg.dir}), not '${projectName}' — for a project with no identity file, use --id (see: orc projects)`)
      const r = await actions().deleteProject(cfg.projectId, CLI_ORIGIN)
      console.log(`deleted '${actual}': ${r.events} event(s), ${r.operations} operation(s)`)
      for (const w of r.warnings) console.log(`warning: ${w}`)
    })

  // The task line format every group (and the orphan bucket) shares, indented so it reads as
  // belonging to the heading printed just above it.
  const taskLine = (t: TaskNode): string => `  ${t.id}  ${t.status.padEnd(17)} ${t.title}`

  program
    .command('tasks')
    .description('list tasks')
    .action(async () => {
      const state = await requireKernel().state()
      const groups = tasksByWorkspace(state)
      const orphans = orphanTasks(state)
      if (groups.every(g => g.tasks.length === 0) && orphans.length === 0) {
        console.log('_no tasks_')
        return
      }
      for (const g of groups) {
        console.log(`# ${g.workspace.title}  (${g.workspace.branch ?? 'detached'})  ${g.workspace.cwd}`)
        for (const t of g.tasks) console.log(taskLine(t))
      }
      // A task naming a workspace the fold never saw is a log defect (every task is created after
      // its workspace exists) — surfaced loudly here rather than silently dropped from a view keyed
      // by workspace, so the operator sees the task AND the missing record it points at.
      if (orphans.length > 0) {
        console.log('# ORPHANED — workspace missing from the log')
        for (const t of orphans) console.log(taskLine(t))
      }
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .option('--json', 'full redacted event records as JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      await requireTask(taskId)
      const events = await requireKernel().eventsFor(taskId)
      if (opts.json) {
        console.log(JSON.stringify(events, null, 2))
        return
      }
      for (const e of events)
        console.log(`${String(e.seq).padStart(4)}  ${e.ts}  ${e.kind}`)
    })

  program
    .command('replay <taskId>')
    .description('read-only audit replay: folded state at an event sequence (default: latest)')
    .option('--at <seq>', "replay up to and including this GLOBAL event sequence — sequences span the whole project log, not one task; see 'orc log <taskId>' for the task's range", parseNonNegativeInteger)
    .action(async (taskId: string, opts: { at?: number }) => {
      await requireTask(taskId)
      const all = await requireKernel().eventsFor(taskId)
      const at = opts.at ?? Number.POSITIVE_INFINITY
      const events = all.filter(e => e.seq <= at)
      const [first] = all
      const last = all.at(-1)
      if (events.length === 0 && first && last) {
        // an empty fold here is a footgun, not data: --at is below this task's first event
        console.error(`no events for '${taskId}' at or before seq ${opts.at} — sequences are GLOBAL across the project log; this task's events span ${first.seq}..${last.seq} (orc log ${taskId})`)
        throw new CommandFailure(EXIT_CODE.failure) // already reported above — the entry point only sets the code
      }
      const state = fold(events)
      console.log(JSON.stringify(
        state,
        (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value),
        2,
      ))
    })

  program
    .command('watch')
    .description("follow the project's whole event log live — one line per event (seq, kind, summary) — until interrupted")
    .option('--since <seq>', 'only events after this sequence (default: a live tail from now, nothing replayed)', parseNonNegativeInteger)
    .option('--kind <kind...>', `only these event kinds (repeatable): ${Object.values(EventKind).join(', ')}`)
    .action(async (opts: { since?: number; kind?: string[] }) => {
      const kinds = opts.kind?.map(k => enumArg<EventKind>('--kind', Object.values(EventKind))(k))
      const unsubscribe = await watchStream(requireKernel(), { since: opts.since, kinds }, line => console.log(line))
      await untilInterrupted()
      await unsubscribe()
    })

  // one shared implementation of every mutating command — the web adapter gets the same object.
  // (discovery is declared up top so the `plan` command's rate line can reach it too)
  const actions = () => buildOrcActions({ kernel: requireKernel(), ensureRuntime, plugin, listModels: discovery?.listModels, listModelOptions: discovery?.listModelOptions })

  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw noProject('execution commands are unavailable in this context')
    return portFactory()
  }

  // How long to wait for a freshly spawned supervisor's first heartbeat. A cold one pays a DBOS
  // launch and a plugin load before it beats, so this is generous — but bounded,
  // so a broken install reports where to look instead of hanging.
  // ponytail: fixed, not configurable — make it a setting if a real deployment ever boots slower.
  const SPAWN_WAIT_MS = 15_000

  // commander maps `--no-daemon` to `daemon: false`. The env var is the same switch for callers
  // that cannot pass flags (the bench harness invokes orc through a shell).
  const noDaemon = (): boolean => program.opts().daemon === false || process.env.ORC_NO_DAEMON === '1'

  // Guarantee something will drive what this command is about to ask for. In-process means THIS
  // command supervises, so the port is built here: its signal router is what reacts to the ask.
  // Without a project context (unit tests, embedded hosts) there is no heartbeat to read and
  // nothing to spawn, so the command holds the runtime itself, exactly as it always did.
  const ensureRuntime = async (): Promise<SupervisorMode> => {
    const storage = plugin?.storage
    const mode = await ensureSupervisor({
      live: storage ? () => liveSupervisors(storage, new Date()) : async () => [],
      spawn: () => spawnSupervisor(needPlugin().config),
      waitMs: SPAWN_WAIT_MS,
      noDaemon: noDaemon() || !storage,
      sleep: ms => Bun.sleep(ms),
      // Lazy like `spawn`: only read once spawning has already happened, which never occurs under
      // noDaemon — so a caller with no project context (tests, embedded hosts) never forces one.
      config: () => needPlugin().config,
    })
    if (mode === SUPERVISOR_MODE.inProcess) await needPort()
    return mode
  }

  const derivedPlanFor = (taskId: string): Promise<string> =>
    derivedPlanBlock(requireKernel(), { autoCommit: plugin?.config.autoCommit, checks: plugin?.config.finishChecks ?? [] }, taskId)

  // What a watch's result means at the shell. The ONE place `new`, `run`, `retry`, `reply` and
  // `approve` share, so they cannot drift on what a terminal outcome, a cancellation or a parked
  // human gate prints and exits with.
  // rootId: the ROOT of the tree that was watched (never a split child) — subtreeUsage sums the
  // whole tree from there, so a caller that named a child would silently undercount everything
  // above it. Every call site below passes rootOf(taskId) (or a root it already computed).
  const report = async (result: TailResult, rootId: string): Promise<void> => {
    // A parked run is not a failure: the work is durable and waiting on a person, so exit 0 and
    // name the one command that unparks it.
    if (result.parked) {
      // the id names the task that ASKED, which after a split is the child, not the task being
      // watched — replying to the wrong one resolves nothing and leaves the tree parked
      console.log(`run parked on a question: ${result.question}`)
      // the human approves THIS, not the prose above it
      const derived = await derivedPlanFor(result.taskId)
      if (derived) console.log(derived)
      console.log(`answer it to continue: orc reply ${result.taskId} <text>`)
      return
    }
    // The terminal summary used to print only 'tokens in/out' or nothing at all — a run's cost is
    // the thing a human actually weighs it against, and hiding where the money goes was the
    // roadmap's explicit complaint. subtreeUsage, not taskUsage: the run's cost is the WHOLE
    // tree's, including every split child, not just the root task's own agent_call events.
    const state = await requireKernel().state()
    console.log(formatUsageLine(subtreeUsage(state, rootId)))
    console.log(`run finished: ${result.outcome}`)
    if (result.outcome !== RunOutcome.done) throw new CommandFailure(EXIT_CODE.failure)
  }

  // The run a whole tree belongs to: a split child's work only ever resolves a gate held by an
  // ancestor, so the root is the run to watch.
  const rootOf = async (taskId: string): Promise<string> => {
    const state = await requireKernel().state()
    let id = taskId
    for (let parent = state.tasks.get(id)?.parentId; parent; parent = state.tasks.get(id)?.parentId) id = parent
    return id
  }

  // Watch a run this terminal already asked for, from the sequence the ask was recorded at. The
  // command starts nothing: a supervisor turns the recorded ask into a workflow, which is why the
  // run outlives the terminal that asked for it.
  const watchFrom = async (taskId: string, since: number | undefined): Promise<void> => {
    console.log(`run requested for ${taskId} — watching (ctrl-c stops watching, not the run: orc cancel ${taskId} stops it)`)
    const root = await rootOf(taskId)
    await report(await watchSubtree(requireKernel(), taskId, since), root)
  }

  // What `--cwd` overrides, spelled ONCE for the two commands that offer it — `run` and `retry` take
  // the same flag to the same kernel call, and two copies would let one of them keep describing a
  // default the other had since changed.
  //
  // "else the project directory" is deliberately gone: requestRun resolves the cwd from the task's
  // workspace and REFUSES a task whose workspace the log never saw, so there is no fallback left for
  // a human to plan around — an orphan is a refusal naming this flag, not a silent run somewhere
  // else. (The execution port still has a project-dir rung, but nothing can reach it: the cwd is
  // resolved before the ask is even recorded.)
  const CWD_OVERRIDE_HELP = "override the working directory (default: the task's workspace)"

  program
    .command('run <taskId>')
    .description('execute the approved plan (durable; the supervisor drives it, re-running attaches)')
    .option('--cwd <dir>', CWD_OVERRIDE_HELP)
    .action(async (taskId: string, opts: { cwd?: string }) => {
      const { since } = await actions().run(taskId, opts.cwd ?? null, CLI_ORIGIN)
      await watchFrom(taskId, since)
    })

  program
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>', CWD_OVERRIDE_HELP)
    .action(async (taskId: string, opts: { cwd?: string }) => {
      const { since } = await actions().retry(taskId, opts.cwd ?? null, CLI_ORIGIN)
      await watchFrom(taskId, since)
    })

  program
    .command('cancel <taskId>')
    .description('cancel the active run (terminal in M2)')
    .action(async (taskId: string) => {
      await actions().cancel(taskId, CLI_ORIGIN)
      console.log('cancelled')
    })

  program
    .command('graph')
    .description('serve the project web UI on 127.0.0.1 — browse the graph, propose, approve and run')
    .option('--port <n>', 'port', parsePositiveInteger, 7749)
    .action(async (opts: { port: number }) => {
      const { startGraphUi } = await import('@orc/graph-ui') // lazy: keep CLI startup lean
      const { appendCopilotExchange } = await import('@orc/graph-ui/copilot-journal')
      const { ensureGraphUiDistFresh } = await import('@orc/graph-ui/dist-freshness')
      const dist = await ensureGraphUiDistFresh() // refuse or rebuild a stale web/dist before serving it
      if (!dist.ok) {
        console.error(`graph ui: web/dist is ${dist.verdict} and could not be rebuilt — run \`${dist.manualBuildCommand}\``)
        throw new CommandFailure(EXIT_CODE.failure)
      }
      if (dist.rebuilt) console.log(`graph ui: web/dist was ${dist.verdict} — rebuilt automatically`)
      const cfg = plugin?.config
      const knowledgeOf = plugin && memoizeFor(KNOWLEDGE_HEALTH_TTL_MS, () => knowledgeHealthOf(plugin, requireKernel()))
      const ui = startGraphUi({
        url: (cfg ?? loadConfig()).databaseUrl,
        port: opts.port,
        cwdProject: cfg ? { id: cfg.projectId, name: cfg.projectName, dir: cfg.dir } : undefined,
        // mutations only when launched inside a project with a real runtime behind it
        actions: portFactory && plugin ? actions() : undefined, // the web door names Door.web per call (server.ts)
        copilot: portFactory && plugin && discovery
          ? buildCopilotConfig(discovery, () => listWorkspaceHealth(needPlugin()), async taskId => {
            const kernel = requireKernel()
            const task = taskId === null ? undefined : await kernel.getTask(taskId)
            return task?.workspaceId ?? (await findCwdWorkspace(kernel, plugin?.config.dir))?.id ?? null
          })
          : undefined,
        defaultCwd: cfg?.dir ?? process.cwd(),
        health: plugin && knowledgeOf ? async () => {
          const supervisor = plugin.storage ? await probeSupervisor(plugin.storage, plugin.config.projectRoot, plugin.config) : undefined
          return { knowledge: await knowledgeOf(), ...(supervisor && { supervisor }) }
        } : undefined,
        // P6: copilot exchanges are events — the log is the record, the browser is a cache
        appendExchange: plugin ? async x => appendCopilotExchange(plugin.log, x, Door.web) : undefined,
      })
      console.log(`graph ui on http://127.0.0.1:${ui.port}`)
      await untilInterrupted()
      await ui.stop()
    })

  // Phase 1 keeps exactly one supervisor per project: the zone write-fence is still an in-process
  // Map (plugins/executor-api-loop/src/tools.ts), so two live supervisors would last-write-wins
  // over each other's files. Phase 2 moves claims to Postgres and raises this — presence is
  // already a heartbeat, so nothing else has to change when it does.
  const PHASE1_MAX_SLOTS = 1
  // one derivation of supervisor health for every door that reports it (graph /api/health, the
  // MCP project_status) — heartbeat rows + the ready-only pid file, classified by supervisorHealth
  const probeSupervisor = async (storage: Storage, projectRoot: string, config?: { databaseUrl: string; projectId: string }) => {
    const now = new Date()
    // the runtime lock answers "is anything DRIVING", which the heartbeat cannot: a --no-daemon
    // command or the graph server holds it without ever writing a supervisor row
    const held = config ? await runtimeLockHeld(config.databaseUrl, config.projectId) : false
    return supervisorHealth(await liveSupervisors(storage, now), await staleSupervisors(storage, now), existsSync(servePidFile(projectRoot)), held)
  }
  const SERVE_NEEDS_STORAGE = 'serve needs a live storage connection'

  const serve = program.command('serve').description('run the project supervisor (holds the execution runtime)')
  serve
    .command('start', { isDefault: true })
    .description('start the supervisor in the foreground (auto-spawned in the background by other commands)')
    .option('--idle <minutes>', 'exit after this long with no live work', parsePositiveInteger, 30)
    .action(async (opts: { idle: number }) => {
      const { host, hub, config, storage } = needPlugin()
      if (!storage) throw new Error(SERVE_NEEDS_STORAGE)
      // Claiming the slot IS the admission decision (task brief "Slot claiming") — a null claim
      // means a live heartbeat already holds every slot Phase 1 allows, not a separate check that
      // could disagree with it.
      const executorId = await claimSlot(storage, PHASE1_MAX_SLOTS)
      if (!executorId) {
        console.error(`another supervisor is already live for '${config.projectName}' — see: orc serve status`)
        throw new CommandFailure(EXIT_CODE.failure)
      }
      // Say something BEFORE buildRuntime, and beat through it: the build blocks on projection
      // catch-up, which is unbounded (a wiped read model replays the whole log — measured
      // 2026-08-01: ~an hour), and a silent, never-beating boot is indistinguishable from a hang
      // for both the operator and the next `orc serve`, which could steal the slot mid-boot.
      console.log(`orc serve: ${executorId}  pid ${process.pid}  booting — projections catch up first ("ready" follows)`)
      const stopBootBeat = startBootHeartbeat(storage, executorId)
      let port: Awaited<ReturnType<typeof buildRuntime>>
      try {
        port = await buildRuntime({ host, hub, config, storage, executorId })
      } finally {
        stopBootBeat() // runSupervisor's own beat takes over from here
      }
      // for `serve status`/`serve stop` only — presence (admission, liveness) is decided by the
      // heartbeat row alone, never by this file's existence
      atomicWriteFileSync(servePidFile(config.projectRoot), `${process.pid}\n`)
      console.log(`orc serve: ready  idle exit after ${opts.idle}m — ctrl-c to stop`)
      // The parallelism ceiling, stated where an operator can act on it: steps run in dependency
      // waves and the whole wave is awaited before the next is scheduled, so `concurrency` is the
      // cap PER DEPTH, not per run. PHASE1_MAX_SLOTS is 1 because the zone write-fence is still an
      // in-process map (plugins/executor-api-loop/src/tools.ts).
      console.log(`  parallelism: ${config.concurrency} concurrent steps per depth (waves are awaited whole) · max depth ${config.maxDepth} · ${PHASE1_MAX_SLOTS} supervisor`)
      console.log(`  ${knowledgeHealthLine(await knowledgeHealthOf({ config, log: storage.events }, requireKernel()))}`)
      try {
        await runSupervisor({ storage, port, idleMs: opts.idle * 60_000 })
      } finally {
        // about to exit either way — draining would block shutdown on an hour-long parked gate
        // (dbos-port.ts's own `drain: false` rationale); recovery owns resumption on the next boot.
        await port.shutdown({ drain: false })
        rmSync(servePidFile(config.projectRoot), { force: true })
      }
    })
  serve
    .command('status')
    .description('list live supervisors')
    .action(async () => {
      const { storage } = needPlugin()
      if (!storage) throw new Error(SERVE_NEEDS_STORAGE)
      const now = new Date()
      const rows = await liveSupervisors(storage, now)
      if (rows.length === 0) console.log('_no live supervisor_')
      for (const r of rows) console.log(`${r.executorId}  pid ${r.pid}  ${r.host}  since ${r.startedAt}  last seen ${r.lastSeenAt}`)
      // A stale row is a supervisor that died holding work. Phase 1 cannot adopt its workflows
      // (that is Phase 2), and the design commits to SURFACING them rather than silently stranding
      // them — so name the slot and what reclaims it, instead of leaving an empty listing that
      // reads as "nothing was lost".
      for (const r of await staleSupervisors(storage, now))
        console.log(`${r.executorId}  STALE  pid ${r.pid}  ${r.host}  last seen ${r.lastSeenAt} — its in-flight work waits for a supervisor to reclaim this slot (orc serve)`)
    })
  serve
    .command('stop')
    .description('stop the live supervisor')
    .action(async () => {
      const { storage } = needPlugin()
      if (!storage) throw new Error(SERVE_NEEDS_STORAGE)
      const rows = await liveSupervisors(storage, new Date())
      if (rows.length === 0) { console.log('_no live supervisor_'); return }
      for (const r of rows) process.kill(r.pid, 'SIGTERM')
      console.log(`sent SIGTERM to ${rows.map(r => r.executorId).join(', ')}`)
    })

  program
    .command('status <taskId>')
    .description('per-step state and cost totals')
    .action(async (taskId: string) => {
      const state = await requireKernel().state()
      const task = state.tasks.get(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      if (plugin) {
        console.log(`project: ${plugin.config.projectName} (${plugin.config.projectId})`)
        console.log(knowledgeHealthLine(await knowledgeHealthOf(plugin, requireKernel())))
      }
      console.log(`${task.id}  ${task.status}  ${task.title}`)
      const plan = state.plans.get(taskId)?.versions.at(-1)
      for (const step of plan?.steps ?? []) {
        const s = state.steps.get(taskId)?.get(step.id)
        const status = s?.status ?? 'pending'
        const detail = s?.failure ? `  [${s.failure.class}] ${s.failure.message}` : (s?.output ? `  → ${s.output}` : '')
        console.log(`  ${step.id.padEnd(12)} ${status.padEnd(10)} attempt ${s?.attempt ?? 0}${detail}`)
        console.log(`    ${formatUsageLine(stepUsage(state, taskId, step.id))}`)
      }
      // D3: a grounded task shows what its analysis covered — and the gaps it did NOT (RG7 honesty).
      const coverage = await requireKernel().latestCoverage(taskId)
      if (coverage)
        console.log(`  analysis: ${coverage.analyzed ? `${coverage.claimsWritten} claims, confidence ${coverage.confidence}` : 'not analyzed'}${coverage.gaps.length ? `  gaps: ${coverage.gaps.join(', ')}` : ''}`)
      // D4 gate, human side: a grounded-plan step parked on ask_human shows its question here, so the
      // conversation isn't one-directional — the human sees the prompt, not just a blind reply target.
      const feedback = await requireKernel().openFeedback(taskId)
      if (feedback) {
        console.log(`  awaiting reply: ${feedback.question}  (orc reply ${taskId} <text>)`)
        const derived = await derivedPlanFor(taskId)
        for (const line of derived ? derived.split('\n') : []) console.log(`  ${line}`)
      }
      // The runtime failing at its own job. Printed LAST and unconditionally, because it explains
      // why a task is not running, not parked, and not terminal: a reaction threw. Outside a
      // supervisor's stdout this is otherwise invisible and reads at the terminal as a hang.
      for (const f of state.reactionFailures.get(taskId) ?? [])
        console.log(`  runtime could not ${f.reaction}${f.causeSeq === null ? '' : ` (seq ${f.causeSeq})`}: ${f.message}`)
      // the other human gate: a split the manual approvalPolicy parked. Same surface, because the
      // parent's join_splits waits on it just as durably as it waits on an answer.
      for (const child of gatedChildren(state, taskId))
        console.log(`  awaiting approval: ${child.title}  (orc approve ${child.id})`)
      const ops = [...state.operations.values()]
        .filter(o => o.taskId === taskId)
        .sort((a, b) => a.startedSeq - b.startedSeq)
      for (const o of ops)
        console.log(`  op  ${o.kind.padEnd(6)} ${o.name.padEnd(24)} ${o.status.padEnd(10)} attempts ${o.attempts}`)
      for (const a of state.artifacts.get(taskId) ?? [])
        console.log(`  out ${(a.stepId ?? '?').padEnd(12)} ${a.path} · sha256:${a.sha256.slice(0, 12)}… · ${a.size}B`)
      console.log(`  ${formatUsageLine(taskUsage(state, taskId))}`)
    })

  program
    .command('skills')
    .description('list indexed skills (vault/skills)')
    .action(async () => {
      const { host } = needPlugin()
      for (const e of host.skills.list()) {
        const mark = e.valid ? 'ok     ' : 'INVALID'
        const summary = e.manifest?.description ?? e.errors.join('; ')
        const desc = summary.length > 80 ? `${summary.slice(0, 77)}...` : summary
        console.log(`${mark} ${e.name.padEnd(24)} ${desc}`)
      }
    })

  const vault = program.command('vault').description('OKF vault projection')
  vault
    .command('render [taskId]')
    .description('render the vault from the event log (all tasks if omitted)')
    .action(async (taskId?: string) => {
      const { config, log } = needPlugin()
      if (taskId && !(await requireKernel().getTask(taskId))) throw new Error(`no task '${taskId}'`)
      const projector = createVaultProjector({ log, config })
      if (taskId) await projector.renderTask(taskId)
      else await projector.renderAll()
      await projector.close()
      console.log(`vault rendered → ${config.vaultDir}`)
    })

  const mcp = program.command('mcp').description('MCP servers (T1 plugins) + serving orc itself')
  mcp
    .command('serve')
    .description('serve orc over stdio as an MCP server — door #2 for external agents (Claude Code, …)')
    .option('--autonomy <mode>', "'gated' (default): approval stays with the human; 'full': the client may approve (attributed as mcp)", 'gated')
    .action(async (opts: { autonomy: string }) => {
      if (opts.autonomy !== 'gated' && opts.autonomy !== 'full')
        throw new Error(`--autonomy must be 'gated' or 'full', got '${opts.autonomy}'`)
      const { config, log, storage } = needPlugin()
      const { startMcpServe, MCP_SERVE_EXECUTOR } = await import('./mcp-serve') // lazy: the SDK loads only here
      await startMcpServe({
        config, log,
        // Resolved BEFORE the server opens: a stdio server that discovered mid-session it cannot
        // name its workspace would surface the refusal as a failed tool call, where here it is a
        // startup error naming the missing project context.
        memoryAuthor: await cwdAuthor(requireKernel(), config.dir, AUTHOR_SOURCE.agent, NO_CHAT(Door.mcp), { executor: MCP_SERVE_EXECUTOR }),
        // 'mcp', so a feedback answer arriving through this door is RECORDED as arriving through
        // it. For a grounded task the conversational 'approve' is the human gate, and
        // approvedPlanHash only honours source 'cli' — so an agent answering 'approve' here now
        // fails that gate honestly instead of satisfying it under a human's name. Operators who
        // DO want the client approving still have the explicit, autonomy-gated `approve` tool.
        actions: portFactory ? actions() : null,
        autonomy: opts.autonomy,
        ...(storage && { supervisor: () => probeSupervisor(storage, config.projectRoot, config) }),
        // project_status names the checkout each task is worked in — a driver's first question in a
        // project with a worktree per request. Read-only, so it is wired whether or not this server
        // can mutate (actions above may be null).
        listWorkspaces: () => listWorkspaceHealth({ log }),
      })
    })
  mcp
    .command('list')
    .description('declared servers and their trust state')
    .action(async () => {
      const { config } = needPlugin()
      const trust = loadTrust(config.projectRoot) // fresh read: grants take effect in the same session's list
      for (const [id, cfg] of Object.entries(config.mcpServers)) {
        const state = isMcpTrusted(trust, id, cfg) ? 'trusted  ' : 'untrusted'
        console.log(`${state} ${id.padEnd(16)} ${cfg.command} ${(cfg.args ?? []).join(' ')}`)
      }
    })
  mcp
    .command('tools <serverId>')
    .description('spawn a trusted server and list its tools')
    .action(async (serverId: string) => {
      const { hub } = needPlugin()
      console.log('vet MCP servers before trusting them: they run as local processes with the permissions of this user')
      for (const t of await hub.listTools(serverId)) console.log(`${t.name.padEnd(24)} ${t.description}`)
      await hub.close()
    })
  mcp
    .command('trust <serverId>')
    .description('grant local trust (writes .orc/trust.json — never commit it)')
    .action(async (serverId: string) => {
      const { config } = needPlugin()
      const declared = config.mcpServers[serverId]
      if (!declared) throw new Error(`undeclared MCP server '${serverId}' — declare it in .orc/config.json first`)
      grantMcpTrust(serverId, declared, config.projectRoot)
      console.log(`trusted mcp server '${serverId}' (bound to its current command/args/env declaration)`)
    })

  const ext = program.command('ext').description('T2 extensions')
  ext
    .command('list')
    .description('declared extensions and their trust state')
    .action(async () => {
      const { host, config } = needPlugin()
      const trust = loadTrust(config.projectRoot) // fresh read: grants take effect in the same session's list
      for (const p of config.extensions) {
        const state = isExtensionTrusted(trust, p, config.projectRoot) ? 'trusted  ' : 'untrusted'
        const active = host.extensions.loaded.find(l => l.path === path.resolve(config.projectRoot, p))
        console.log(`${state} ${p}${active ? `  (loaded: ${active.manifest.id})` : ''}`)
      }
    })
  ext
    .command('trust <path>')
    .description('grant local trust to a declared extension')
    .action(async (p: string) => {
      const { config } = needPlugin()
      if (!config.extensions.some(e => path.resolve(config.projectRoot, e) === path.resolve(config.projectRoot, p)))
        throw new Error(`undeclared extension '${p}' — declare it in .orc/config.json first`)
      grantExtensionTrust(p, config.projectRoot)
      console.log(`trusted extension '${p}' (bound to its current content) — takes effect on the next orc invocation`)
    })

  return program
}
