import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, InvalidArgumentError } from 'commander'
import { AUTHOR_SOURCE, SUPERVISOR_HEALTH, claimHistory, EDGE_DIRECTION, errorMessage, EVENT_KIND, foldMemory, LINK_KINDS, MASTERPLAN_NOTE_ID, MEMORY_ACCESS, MemoryDeletedPayload, MemoryScope, MemoryWrittenPayload, noteKey, NOTE_KINDS, NoteKind, NOTE_TIER, NOTE_TIERS, NoteTier, parseLinkSpec, PlanDraft, ROLE_SKILL, RUN_OUTCOME, STRATEGY, TASK_STATUS, TERMINAL_TASK_STATUS, LinkKind, slugId, type Analyzer, type EventRecord, type MemoryAuthor, type MemoryLink, type NoteFields, type ExecutionPort, type MemoryHealth, type Plan, type TaskNode, type WorkspaceWithHealth, formatModelRate } from '@orc/contracts'
import { openStorage, Kernel, atomicWriteFileSync, listProjectIds, claimSlot, fold, gatedChildren, freezePlan, liveSupervisors, orphanTasks, staleSupervisors, grantExtensionTrust, grantMcpTrust, initializeProject, isExtensionTrusted, isMcpTrusted, loadConfig, loadTrust, migrateDatabase, requireProject, runtimeLockHeld, stepUsage, subtreeUsage, tasksByWorkspace, taskUsage, type EventLog, type OrcConfig, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'
import { createVaultProjector, parsePlanFile } from '@orc/vault-projector'
import { archiveCandidates, consolidateTask, CONSOLIDATE_EXECUTOR, createDriftProbe, frontier, needsReground, probeMemory, RECHECK_KINDS, recheckNotes, restampToHead, summarize } from '@orc/memory'
import { withMemory } from './memory-open'
import { DEFAULT_TEMPLATE_MODEL, singleStepDraft } from './plan-template'
import { buildDistiller } from './consolidation-distiller'
import { seedRegistries, buildRuntime } from './runtime'
import { runSupervisor, startBootHeartbeat, supervisorHealth } from './serve'
import { ensureSupervisor, SUPERVISOR_MODE, type SupervisorMode } from './supervisor-client'
import { isLanguageModel } from './model-guard'
import { assertDrivable, assertRetryable, buildModelDiscovery, buildOrcActions } from './actions'
import { cwdAuthor, cwdWorkspaceId } from './cwd-workspace'
import { renderDerivedPlan, renderPlanHuman } from './plan-render'
import { wsCommand } from './ws-commands'
import { requireLiveWorkspace } from './workspace-ops'
import { listWorkspaceHealth } from './workspace-health'
import { serveLogFile, servePidFile } from './serve-paths'
import { CommandFailure } from './exit'
import { formatUsageLine } from './usage-render'
import { watchSubtree, type TailResult } from './watch'


function buildCopilotConfig(discovery: ReturnType<typeof buildModelDiscovery>, listWorkspaces: () => Promise<WorkspaceWithHealth[]>) {
  return {
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    listModels: discovery.listModels,
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

// loadConfig is the ONE resolution of env → .orc/config.json → default; every command
// (read-only or executing) must land on the same database, bound to one project
export async function openKernel(
  url: string,
  opts: {
    projectId?: string
    redactEnv?: string[]
    refValidator?: (plan: Plan) => Promise<string[]>
    analyzers?: Map<string, Analyzer>
    send?: (workflowId: string, message: string, topic: string, idempotencyKey: string) => Promise<void>
    onAppend?: (e: EventRecord) => void
  } = {},
): Promise<{ kernel: Kernel; log: EventLog; storage: Storage }> {
  // one config read for both the project binding and the approval doors: the gate's accepted-door
  // set is operator config, so every kernel this factory hands out must already carry it — a
  // kernel built on the default list would silently refuse approvals the operator opened a door for.
  const config = loadConfig()
  const projectId = opts.projectId ?? requireProject(config).projectId
  const storage = await openStorage(url, { projectId, redactEnv: opts.redactEnv })
  const log = storage.events
  if (opts.onAppend) log.onAppend = opts.onAppend
  return { kernel: new Kernel(log, opts.refValidator, opts.analyzers, opts.send, config.groundedApprovalDoors), log, storage }
}

// The committed plan that re-grounds a drifted graph. ONE spelling: the status line and the
// supervisor banner both name it, and it is a real path a reader will paste. Exported so
// shipped-skills.test.ts's driftLine pins assert against the same string driftLine actually
// prints, rather than a second copy of the path that could drift from this one.
export const REGROUND_PLAN = 'docs/kb-build-parallel.plan.json'

// P5: driftLine could only ever recommend REGROUND_PLAN's full remap, even for a handful of stale
// notes — healing ~10 drifted notes had no targeted instrument, only "re-derive all ten area notes
// from scratch". This is the cheaper tier-3 instrument: one auditor step that walks the notes
// memory_search already flags drifted and heals/confirms each via memory_write/memory_verify,
// writing no source files. Below the reground threshold (needsReground), a handful of stale notes
// doesn't justify redoing the whole graph, so the advisory now names this instead of REGROUND_PLAN.
// Exported for the same reason as REGROUND_PLAN: shipped-skills.test.ts reads the tracked plan
// file at this path and pins driftLine's below-threshold wording against it — one spelling, so a
// rename here cannot leave either check pointed at a path that no longer exists.
export const REGROUND_HEAL_PLAN = 'docs/reground-heal.plan.json'

// How a drift reading reads to a human. Lives here, not in the memory plugin: which command to
// recommend is a CLI concern, and a measurement module that builds prose ends up shipping a
// hardcoded path inside a pure function. Exported so shipped-skills.test.ts can pin each branch's
// wording without re-typing REGROUND_PLAN/REGROUND_HEAL_PLAN as a second literal.
export const driftLine = (d: NonNullable<MemoryHealth['drift']>): string => {
  const pct = Math.round(d.ratio * 100)
  return needsReground(d)
    ? `knowledge drift: at least ${d.drifted}/${d.checkable} checkable notes (${pct}%) describe code changed since they were written — something moved this repo without going through orc. Re-ground: orc propose <task> --file ${REGROUND_PLAN}`
    : `knowledge drift: ${d.drifted}/${d.checkable} checkable notes (${pct}%) describe code that has since changed — heal: orc propose <task> --file ${REGROUND_HEAL_PLAN}`
}

const SHIPPED_SKILLS_DIR = fileURLToPath(new URL('../../../vault/skills', import.meta.url))
export const SHIPPED_SKILLS = ['codebase-analysis', 'plan-authoring', 'documentation', 'web-research', ROLE_SKILL.auditor, ROLE_SKILL.committer]

// `orc init` must work before Postgres/plugins exist, so it gets a standalone entry
// (bin.ts) and the same command inside buildProgram for help/unit visibility
export function initCommand(dir?: string): Command {
  return new Command('init')
    .description('initialize project identity (writes .orc/identity.json — local, never committed)')
    .requiredOption('--name <name>', 'project name')
    .option('--force', 'mint a new identity for a deliberate fork of an existing project')
    .action((opts: { name: string; force?: boolean }) => {
      const projectDir = dir ?? process.cwd()
      const identity = initializeProject(projectDir, opts.name, { force: opts.force })
      const config = loadConfig(projectDir)
      for (const name of SHIPPED_SKILLS) {
        const target = path.join(config.skillsDir, name, 'SKILL.md')
        if (existsSync(target)) continue
        mkdirSync(path.dirname(target), { recursive: true })
        copyFileSync(path.join(SHIPPED_SKILLS_DIR, name, 'SKILL.md'), target)
      }
      console.log(`initialized project '${identity.projectName}' (${identity.projectId}) in ${identity.projectRoot}`)
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

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError(`must be a non-negative integer, got '${value}'`)
  return parsed
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new InvalidArgumentError(`must be a positive amount, got '${value}'`)
  return parsed
}

// ONE spelling of "reject a value outside a closed vocabulary, naming the set" — the alternative is
// a typo silently filtering everything out and reading as "this lane is empty". Three call sites had
// grown their own version of it (the tier lane, `neighbors --kinds`, and now `memory add --kind`),
// each with a different error shape for the identical mistake, and the --kinds one additionally
// re-parsed the value through zod afterwards purely to avoid a cast.
// `.find` returns the MEMBER type, so this needs neither a cast nor a second parse.
function enumArg<T extends string>(label: string, valid: readonly T[]): (value: string) => T {
  return (value: string): T => {
    const hit = valid.find(v => v === value)
    if (hit === undefined)
      throw new InvalidArgumentError(`unknown ${label} '${value}' — valid: ${valid.join(', ')}`)
    return hit
  }
}

const parseNoteTier = enumArg<NoteTier>('tier', NOTE_TIERS)
// Without this a human could not record a DECISION at any door: `memory add` had no kind flag, so
// every note either human door produced defaulted to 'fact' and only an agent mid-step could mint
// a decision. 'adr' is the near-miss it catches — that is a tag, never a kind.
const parseNoteKind = enumArg<NoteKind>('kind', NOTE_KINDS)

// neighbors --depth must be >= 1: the store default is 2 and rankNeighbors requires a positive
// hop count (depth 0 traverses nothing and silently returns []), so reject it at parse time with
// a clear error rather than letting a 0 look like "no neighbors".
function parsePositiveInteger(value: string): number {
  const parsed = parseNonNegativeInteger(value)
  if (parsed < 1) throw new InvalidArgumentError(`must be a positive integer (>= 1), got '${value}'`)
  return parsed
}

function resolveDraft(task: { title: string; spec: string }, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }, taskId: string, config?: OrcConfig): PlanDraft {
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
  return opts.file
    ? PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8')))
    : singleStepDraft(task, opts.model, opts.skill ?? [], config?.maxIterations)
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
): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')
  program.option('--no-daemon', 'hold the execution runtime in this command instead of a background supervisor (tests, CI, benchmarks)')
  program.addCommand(initCommand(plugin?.config.dir))
  program.addCommand(databaseCommand(plugin?.config.dir))

  const needPlugin = () => {
    if (!plugin) throw new Error('plugin commands are unavailable in this context')
    return plugin
  }

  // same shape as needPlugin: every command handler that touches the kernel goes through this,
  // so a handler that somehow ran under --help fails with an actionable message instead of a bare
  // null-reference TypeError.
  const requireKernel = (): Kernel => {
    if (!kernel) throw new Error('this command needs a project context (only --help works without one)')
    return kernel
  }

  // Placed after requireKernel rather than beside the init/db addCommands above: the deps object
  // reads that binding immediately, so calling wsCommand up there would hit its temporal dead zone.
  program.addCommand(wsCommand({ requireKernel, ...(plugin && { project: { config: plugin.config, log: plugin.log } }) }))

  // The author every `orc memory` write carries, in ONE place — a dozen handlers each spelling
  // their own `{ source: cli, workspaceId: … }` is exactly the shape that leaves one command
  // writing knowledge under the wrong checkout. Folded per invocation rather than captured once:
  // `orc ws new` can mint a workspace mid-session, and a boot-time snapshot would not see it.
  const cliAuthor = (): Promise<MemoryAuthor> => cwdAuthor(requireKernel(), plugin?.config.dir, AUTHOR_SOURCE.cli)

  // Discovery-backed model validation rejects invented refs at creation time on every surface;
  // declared here (not at the actions site below) so the `plan` command's rate line can reach it.
  const discovery = plugin ? buildModelDiscovery(plugin.config, plugin.log) : undefined

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
      if (opts.workspace !== undefined) await requireLiveWorkspace(requireKernel(), opts.workspace)
      const workspaceId = opts.workspace
        ?? (opts.parent === undefined ? await cwdWorkspaceId(requireKernel(), plugin?.config.dir) : undefined)
      if (opts.strategy !== STRATEGY.groundedPlan) {
        const t = await requireKernel().createTask({ title, spec: opts.spec, parentId: opts.parent, budgetUSD: opts.budget ?? null, workspaceId })
        console.log(t.id)
        return
      }
      if (!opts.model) throw new Error(`--model is required with --strategy ${STRATEGY.groundedPlan}`)
      const t = await requireKernel().createGroundedTask({
        title, spec: opts.spec, modelRef: opts.model, analyzerRef: opts.analyzer, parentId: opts.parent, budgetUSD: opts.budget ?? null, workspaceId,
        modelCatalog: await discovery?.listModelOptions().catch(() => []) ?? [],
        ...(plugin ? { maxIterations: plugin.config.maxIterations } : {}),
      })
      console.log(t.id)
      // auto-start: the grounded-plan template is policy-approved (its real gate is the
      // conversational one inside the plan step), so the analyze→plan conversation begins now
      await requestAndWatch(t.id, {})
    })

  const requireTask = async (taskId: string) => {
    const task = await requireKernel().getTask(taskId)
    if (!task) throw new Error(`no task '${taskId}'`)
    return task
  }
  const planAction = (apply: (taskId: string, draft: PlanDraft) => Promise<Plan>, describe: (plan: Plan) => string) =>
    async (taskId: string, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }) => {
      const task = await requireTask(taskId)
      const plan = await apply(taskId, resolveDraft(task, opts, taskId, plugin?.config))
      console.log(`plan v${plan.version} ${describe(plan)} — review with: orc plan ${taskId}`)
    }

  program
    .command('propose <taskId>')
    .description('stamp a plan for review (default: a single-step template of your spec — NO model call; --file supplies an authored multi-step draft)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', DEFAULT_TEMPLATE_MODEL)
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .action(planAction((id, draft) => requireKernel().proposePlan(id, draft), plan => `proposed (${plan.steps.length} steps)`))

  program
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', DEFAULT_TEMPLATE_MODEL)
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .option('--from-vault', 'read the edited plan markdown from the vault')
    .action(planAction((id, draft) => requireKernel().editPlan(id, draft), () => 'edited'))

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
      // Approving only UNBLOCKS a split child — something still has to execute it, exactly as with
      // `orc reply`, and a bare approval used to leave the parent parked inside join_splits while
      // the child never started. A supervisor is what executes it (its router reacts to
      // plan_approved), so make sure one exists BEFORE the approval it has to react to. A root's
      // own approval stays a pure approval — running it is a separate decision (`orc run`).
      const root = await rootOf(taskId)
      if (root !== taskId) await ensureRuntime()
      const plan = await requireKernel().approvePlan(taskId, opts.version)
      console.log(`plan v${plan.version} approved`)
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
      await requireKernel().annotatePlan(taskId, { targetNote: noteId, refs: opts.ref ?? [], text })
      console.log(`noted on '${noteId}'`)
    })

  program
    .command('reply <taskId> <text>')
    .description("answer a task's open feedback question (e.g. 'orc reply <taskId> approve'), then drive the resumed run")
    .action(async (taskId: string, text: string) => {
      // Answering only UNBLOCKS the step — something still has to carry the answer into the parked
      // workflow (the supervisor's router does, off feedback_provided) and then keep executing. A
      // reply from a fresh terminal used to leave the answer sitting durable in DBOS's notification
      // table with nobody to act on it; ensuring a supervisor first is what makes this command's
      // promise true. No run is requested: the run already exists, parked on the question.
      await ensureRuntime()
      const topic = await requireKernel().replyFeedback(taskId, text)
      if (!topic) {
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
    .requiredOption('--scope <ids...>', 'plan-note ids to revise (only their decomposes_into subtree changes; every other note stays byte-stable)')
    .action(async (taskId: string, text: string, opts: { scope: string[] }) => {
      // annotate-and-resume sugar over `plan-note … && reply`: queue the same change onto each scoped
      // note, then wake the parked plan step so it reads them (read_annotations) and revises in place.
      const { topic } = await actions().revise(taskId, text, opts.scope)
      console.log(topic
        ? `revised ${opts.scope.join(', ')} — answered feedback:${topic}`
        : `annotated ${opts.scope.join(', ')} — no open feedback to resume (the agent reads them on its next revise)`)
    })

  program
    .command('purge <projectName>')
    .description("cancel running work and delete the named project's events, operations, and memory read model — identity stays (clean slate for re-testing)")
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project history')
    .action(async (projectName: string) => {
      // The target comes from whatever .orc/config.json the cwd resolves to, so a script that
      // drifts into another directory purges a project it never meant to touch — that is not
      // hypothetical, it destroyed a live run's history. Naming the project makes the caller
      // state its intent, and a drifted cwd fails loudly instead of deleting the wrong history.
      const cfg = plugin?.config
      if (!cfg?.projectName) throw new Error('purging needs a project context')
      const actual = cfg.projectName
      if (projectName !== actual)
        throw new Error(`refusing: this directory is project '${actual}' (${cfg.dir}), not '${projectName}'`)
      const r = await actions().purgeProject()
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
      //
      // Names are NOT resolved here. A foreign project's name lives in a memory note inside its own
      // read model, and reading that means opening its Surreal database — a listing must not do
      // that for every row just to print a label. The cwd project knows its own name; the rest are
      // exactly the ones you cannot name, which is the fact worth showing.
      const cfg = plugin?.config
      if (!cfg) throw new Error('listing projects needs a project context')
      const ids = await listProjectIds(cfg.databaseUrl)
      if (ids.length === 0) return console.log('_no projects_')
      for (const id of ids)
        console.log(id === cfg.projectId ? `${id}\t${cfg.projectName}\t<- this directory` : `${id}\t(no identity here — delete with: orc delete --id ${id} --yes)`)
    })

  program
    .command('delete [projectName]')
    .description("delete a project entirely — history, knowledge and durable-execution state (purge keeps the chat; this does not)")
    .option('--id <projectId>', 'delete a FOREIGN project by id — for one whose identity file is gone, so no name exists to confirm against (see: orc projects)')
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project and its knowledge')
    .action(async (projectName: string | undefined, opts: { id?: string }) => {
      const cfg = plugin?.config
      if (!cfg) throw new Error('deleting a project needs a project context')
      if (opts.id !== undefined) {
        // An orphan has no name to confirm against — the id IS the confirmation, and it must not
        // be the project you are standing in, which `delete <name>` already covers with a check
        // that can actually verify what it is deleting.
        if (projectName !== undefined)
          throw new Error('pass a name or --id, not both: a name confirms the cwd project, --id targets a foreign one')
        if (opts.id === cfg.projectId)
          throw new Error(`refusing: ${opts.id} is THIS directory's project — delete it by name (orc delete ${cfg.projectName} --yes) so the name confirms the target`)
        const r = await actions().deleteProject(opts.id)
        console.log(`deleted ${opts.id}: ${r.events} event(s), ${r.operations} operation(s)`)
        for (const w of r.warnings) console.log(`warning: ${w}`)
        return
      }
      // named for the same reason purge is: the target comes from the cwd's config, so a script
      // in the wrong directory would otherwise delete a project it never meant to touch
      if (!cfg.projectName) throw new Error('deleting a project needs a project context')
      const actual = cfg.projectName
      if (projectName !== actual)
        throw new Error(`refusing: this directory is project '${actual}' (${cfg.dir}), not '${projectName}' — for a project with no identity file, use --id (see: orc projects)`)
      const r = await actions().deleteProject(cfg.projectId)
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
        throw new CommandFailure(1) // already reported above — the entry point only sets the code
      }
      const state = fold(events)
      console.log(JSON.stringify(
        state,
        (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value),
        2,
      ))
    })

  // one shared implementation of every mutating command — the web adapter gets the same object.
  // (discovery is declared up top so the `plan` command's rate line can reach it too)
  const actions = (via?: 'cli' | 'mcp') => buildOrcActions({ kernel: requireKernel(), ensureRuntime, plugin, via, listModels: discovery?.listModels, listModelOptions: discovery?.listModelOptions })

  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw new Error('execution commands are unavailable in this context')
    return portFactory()
  }

  // How long to wait for a freshly spawned supervisor's first heartbeat. A cold one pays a DBOS
  // launch, a plugin load and a Surreal connect before it beats, so this is generous — but bounded,
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

  // What a watch's result means at the shell. The ONE place `new`, `run`, `retry`, `reply` and
  // `approve` share, so they cannot drift on what a terminal outcome, a cancellation or a parked
  // human gate prints and exits with.
  // The executable plan the task's notes derive to, or '' when there is no note graph to derive
  // from. A dangling decomposes_into makes freezePlan throw — that is precisely what the
  // human needs to see at the gate, so it is reported rather than allowed to crash it.
  const derivedPlanBlock = async (taskId: string): Promise<string> => {
    try {
      const notes = await requireKernel().listPlanNotes(taskId)
      if (!notes.some(n => n.id === MASTERPLAN_NOTE_ID)) return ''
      // the freeze's own derivation, so the human sees EXACTLY what finalize_plan will freeze —
      // with autoCommit that includes the kernel-appended commit tail
      return renderDerivedPlan(freezePlan(MASTERPLAN_NOTE_ID, notes, { autoCommit: plugin?.config.autoCommit }))
    } catch (err) {
      return `the plan notes do not derive a runnable plan: ${errorMessage(err)}`
    }
  }

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
      const derived = await derivedPlanBlock(result.taskId)
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
    if (result.outcome !== RUN_OUTCOME.done) throw new CommandFailure(1)
  }

  // The run a whole tree belongs to: a split child's work only ever resolves a gate held by an
  // ancestor, so the root is the run to watch.
  const rootOf = async (taskId: string): Promise<string> => {
    const state = await requireKernel().state()
    let id = taskId
    for (let parent = state.tasks.get(id)?.parentId; parent; parent = state.tasks.get(id)?.parentId) id = parent
    return id
  }

  // The admission `startRunAt` enforces, checked here so a request that could never be served is
  // refused BEFORE it is recorded: a run_requested naming a draft task would sit in the log for
  // good, and every supervisor that boots would pick it up and fail on it again. The shared
  // implementation lives in actions.ts so this CLI door and the web/MCP doors cannot drift.
  const requireDrivable = (taskId: string): Promise<void> => assertDrivable(requireKernel(), taskId)

  // Ask for a run, then watch it. The command starts nothing: a supervisor turns the recorded ask
  // into a workflow, which is why the run now outlives the terminal that asked for it.
  const requestAndWatch = async (taskId: string, opts: { cwd?: string; retry?: boolean }): Promise<void> => {
    await ensureRuntime()
    const since = await requireKernel().requestRun(taskId, opts)
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
      await requireDrivable(taskId)
      await requestAndWatch(taskId, { cwd: opts.cwd })
    })

  program
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>', CWD_OVERRIDE_HELP)
    .action(async (taskId: string, opts: { cwd?: string }) => {
      // the same refusal port.retry made, kept client-side for the same reason as requireDrivable:
      // an ask nobody can serve must not reach the log — one implementation, shared with the doors
      await assertRetryable(requireKernel(), taskId)
      await requestAndWatch(taskId, { cwd: opts.cwd, retry: true })
    })

  program
    .command('cancel <taskId>')
    .description('cancel the active run (terminal in M2); sweeps knowledge notes the cancelled subtree still owns')
    .action(async (taskId: string) => {
      const { swept, sweepError } = await actions().cancel(taskId)
      console.log('cancelled')
      if (sweepError) console.warn(`sweep skipped: ${sweepError} — orphaned notes remain (content is still in the event log)`)
      for (const n of swept) console.log(`swept ${n.scope === 'project' ? '' : `${n.scope}/`}${n.id} — ${n.title}`)
      if (swept.length > 0) console.log(`swept ${swept.length} orphaned note(s); content preserved in the event log`)
    })

  program
    .command('graph')
    .description('serve the project web UI on 127.0.0.1 — browse the graph, propose, approve and run')
    .option('--port <n>', 'port', parsePositiveInteger, 7749)
    .action(async (opts: { port: number }) => {
      const { startGraphUi } = await import('@orc/graph-ui') // lazy: keep CLI startup lean
      const cfg = plugin?.config
      const ui = startGraphUi({
        url: (cfg ?? loadConfig()).databaseUrl,
        port: opts.port,
        cwdProject: cfg ? { id: cfg.projectId, name: cfg.projectName, dir: cfg.dir } : undefined,
        memoryHalfLifeDays: (cfg ?? loadConfig()).memoryHalfLifeDays,
        // mutations only when launched inside a project with a real runtime behind it
        actions: portFactory && plugin ? actions() : undefined,
        copilot: portFactory && plugin && discovery
          ? buildCopilotConfig(discovery, () => listWorkspaceHealth(needPlugin()))
          : undefined,
        defaultCwd: cfg?.dir ?? process.cwd(),
        // degraded-memory + supervisor visibility: the footer badge polls this — probe per call,
        // no cache. Supervisor state answers "is anything driving?" (2026-08-01's recurring blind
        // spot) from the heartbeat rows + the pid file serve writes only once its runtime is ready.
        health: plugin ? async () => {
          // The supervisor's pid gates the stage: probeMemory reports one only when the process
          // that published it is the one driving now. See its comment for why pid beats an age.
          const supervisor = plugin.storage ? await probeSupervisor(plugin.storage, plugin.config.projectRoot, plugin.config) : undefined
          return {
            memory: await probeMemory(plugin.config, plugin.log, supervisor?.pid),
            ...(supervisor && { supervisor }),
          }
        } : undefined,
        // P6: copilot exchanges are events — the log is the record, the browser is a cache
        appendExchange: plugin ? async x => {
          await plugin.log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.copilot_exchange, payload: x.payload, usage: x.usage })
        } : undefined,
      })
      console.log(`graph ui on http://127.0.0.1:${ui.port}`)
      await new Promise(() => {}) // serve until Ctrl-C
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
        throw new CommandFailure(1)
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
      // Boot is the one moment an operator is guaranteed to be reading, but only the re-ground
      // case earns a line: a supervisor reporting a number every start teaches the reader to skip
      // its output, and `orc status` has the number on demand.
      try {
        const { drift } = await probeMemory(config, storage.events)
        if (drift && needsReground(drift)) console.log(`  ${driftLine(drift)}`)
      } catch (err) {
        // Never blocks boot — but say WHY it is missing, or a permanently broken probe reads as a
        // clean graph, which is the failure this whole signal exists to prevent.
        console.warn(`  knowledge drift not measured: ${errorMessage(err)}`)
      }
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
        const health = await probeMemory(plugin.config, plugin.log)
        console.log(`memory: ${health.state}${health.reason ? ` (${health.reason})` : ''}`)
        // Two different lags, reported separately on purpose: `state`/`pending` is the read model
        // catching up with the log, which orc fixes by itself; drift is the corpus lagging the CODE,
        // which it cannot. Always print the ratio when measurable — a graph quietly 20% behind is
        // worth knowing before the advisory threshold makes it loud.
        if (health.drift) console.log(driftLine(health.drift))
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
        console.log(`  analysis: ${coverage.analyzed ? `${coverage.notesWritten} notes, confidence ${coverage.confidence}` : 'not analyzed'}${coverage.gaps.length ? `  gaps: ${coverage.gaps.join(', ')}` : ''}`)
      // D4 gate, human side: a grounded-plan step parked on ask_human shows its question here, so the
      // conversation isn't one-directional — the human sees the prompt, not just a blind reply target.
      const feedback = await requireKernel().openFeedback(taskId)
      if (feedback) {
        console.log(`  awaiting reply: ${feedback.question}  (orc reply ${taskId} <text>)`)
        const derived = await derivedPlanBlock(taskId)
        for (const line of derived ? derived.split('\n') : []) console.log(`  ${line}`)
      }
      // The runtime failing at its own job. Printed LAST and unconditionally, because it is the one
      // thing that explains a task which is not running, not parked, and not terminal either: a
      // reaction threw, so nobody acted on something the log records as asked. It used to be
      // invisible outside a supervisor's stdout, which read at the terminal as a hang.
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
        memoryAuthor: await cwdAuthor(requireKernel(), config.dir, AUTHOR_SOURCE.agent, { executor: MCP_SERVE_EXECUTOR }),
        // 'mcp', so a feedback answer arriving through this door is RECORDED as arriving through
        // it. For a grounded task the conversational 'approve' is the human gate, and
        // approvedPlanHash only honours source 'cli' — so an agent answering 'approve' here now
        // fails that gate honestly instead of satisfying it under a human's name. Operators who
        // DO want the client approving still have the explicit, autonomy-gated `approve` tool.
        actions: portFactory ? actions('mcp') : null,
        autonomy: opts.autonomy,
        ...(storage && { supervisor: () => probeSupervisor(storage, config.projectRoot, config) }),
        // project_status names the checkout each task is worked in — a driver's first question in a
        // project with a worktree per request. Read-only, so it is wired whether or not this server
        // can mutate (actions above may be null).
        listWorkspaces: () => listWorkspaceHealth({ config, log }),
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

  const mem = program.command('memory').description('project knowledge graph (M4b)')
  mem
    .command('add')
    .description('write or update a memory note')
    .requiredOption('--id <id>', 'note id')
    // optional, matching the TOOL boundary: the store merges the stored title forward on an
    // update (merge-on-omit, store.ts's undefined-is-omission rule), so requiring it here made
    // this door reject updates the same write accepts from an agent — observed live adding one
    // supersedes link, which demanded the title be retyped verbatim to not change anything.
    .option('--title <title>', 'note title (required for a NEW note; an update keeps the stored one)')
    .option('--summary <s>', 'short summary')
    .option('--body <b>', 'note body (markdown)')
    .option('--tags <tags...>', 'tags')
    .option('--categories <categories...>', 'categories')
    // The human door for a DECISION. Omitted keeps the schema default ('fact') on a new note and,
    // under merge-on-omit, the stored kind on an update — so adding a link to an existing decision
    // does not silently demote it to a fact.
    .option('--kind <k>', `what kind of knowledge: ${NOTE_KINDS.join(' | ')}`, parseNoteKind)
    // Without this the CLI could create knowledge but never wire it in, so every human-authored
    // note landed isolated — reachable by search, invisible to traversal. Same shorthand the web
    // note editor uses, so a note wired from either surface is the same edge.
    .option('--links <spec>', "typed edges, comma-separated: 'refines:area-memory, other-note'", parseLinkSpec)
    // Claims were writable only by an agent through memory_write, so correcting one stale statement
    // by hand meant running an agent. These are the same two fields that tool takes (`addClaims` /
    // `invalidates`) — additive by design: state what to add and what to retire, never the whole
    // array, because supplying the array would REPLACE under the store's merge-on-omit rule.
    .option('--claim <text...>', 'state a claim on this note (addClaims) — repeatable')
    .option('--invalidate <claimId...>', 'retire a claim by its 12-hex id (invalidates) — repeatable')
    .action(async (o: { id: string; title?: string; summary?: string; body?: string; tags?: string[]; categories?: string[]; kind?: NoteKind; links?: MemoryLink[]; claim?: string[]; invalidate?: string[] }) => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        // the tool boundary's own refusal, at this door too: a NEW note without a title fails the
        // schema anyway, but with a zod trace where the writer needs the one-line rule. Drain
        // first so the existence check reads the log's present, not the last projection — a
        // refusal must never hinge on a lagging read model.
        if (o.title === undefined) {
          await memory.projector.catchUp()
          if (await memory.store.get(o.id) === null)
            throw new Error('a new note needs a title (it derives the id) — pass an id instead to update an existing note')
        }
        await memory.store.write({
          id: o.id, title: o.title, summary: o.summary, body: o.body,
          tags: o.tags, categories: o.categories, links: o.links,
          // conditional spread, not a bare `kind: o.kind`: an optional field set to undefined
          // ERASES the stored column, so an unflagged update would wipe the note's kind
          ...(o.kind !== undefined && { kind: o.kind }),
          ...(o.claim !== undefined && { addClaims: o.claim }),
        }, await cliAuthor(), { ...(o.invalidate !== undefined && { invalidates: o.invalidate }) })
        await memory.projector.catchUp() // one-shot: no live subscription in a CLI process, so project the append now
      })
      console.log(`wrote memory '${o.id}'`)
    })
  mem
    .command('rm <id>')
    .description('delete a memory note')
    .option('--scope <s>', 'scope')
    .action(async (id: string, o: { scope?: string }) => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        await memory.store.remove(id, o.scope, await cliAuthor())
        await memory.projector.catchUp()
      })
      console.log(`deleted '${id}'`)
    })
  mem
    .command('recheck')
    .description('recompute every note\'s currency against HEAD and report what the graph could retire')
    .option('--candidates', 'list only what is retirable, with the evidence for each')
    .option('--apply', 'archive the retirable notes (default: report only)')
    .action(async (o: { candidates?: boolean; apply?: boolean }) => {
      const { config, log } = needPlugin()
      // RECHECK_KINDS, not a hand-spelled list: a previous one omitted memory_verified, so a
      // note an auditor had confirmed still counted as drifted here while health called it clean.
      // The named set also carries memory_outcome — the used-but-useless rule's only input.
      const events = await log.after(0, RECHECK_KINDS)
      const terminalTaskIds = new Set(
        [...(await requireKernel().state()).tasks.values()]
          .filter(t => TERMINAL_TASK_STATUS.has(t.status))
          .map(t => t.id),
      )
      const notes = await recheckNotes(events, { changedSince: createDriftProbe(config.dir), terminalTaskIds })
      const s = summarize(notes)
      // "current" means CHECKED and unmoved. A note with no stamp or no declared paths was never
      // compared to anything, so it is reported as never-checked rather than folded into current —
      // that conflation printed 49 of 84 notes "current" against 5 genuinely checked.
      console.log(`${s.total} note(s): ${s.clean} current, ${s.drifted} drifted, ${s.uncheckable} never checked, ${s.unknown} unreachable`)

      const goes = archiveCandidates(notes)
      const byKey = new Map(notes.map(n => [n.key, n]))
      if (o.candidates || goes.length > 0) {
        for (const c of goes) {
          const n = byKey.get(c.key)
          // `scope/id`, never the raw composite key: noteKey joins the two with a NUL, which reads
          // as a space in a terminal and makes the whole line BINARY to grep — a retirable list
          // nobody can pipe into anything is a list nobody can act on in bulk.
          console.log(`${n ? `${n.scope}/${n.id}` : c.key}\t${c.reason}\t${c.evidence}\t${n?.title ?? ''}`)
        }
      }
      // No clock anywhere in this verdict: candidacy is `superseded` or `task-settled`, both facts
      // rather than durations. A drifted note is the HEAL loop's work, not this one's, and a note
      // whose paths have not moved is still true however old or cold — see archive.ts.
      if (goes.length === 0) {
        console.log('_nothing is retirable — every note is current, protected, or uncheckable_')
        return
      }
      if (!o.apply) {
        console.log(`${goes.length} note(s) are retirable on evidence (not age) — re-run with --apply to archive`)
        return
      }
      // Archiving is a WRITE of the same note with archived:true, so merge-on-omit carries every
      // other field forward untouched and the log keeps every revision — `orc memory restore <id>`
      // brings it back. Nothing is deleted.
      await withMemory({ log, config }, async memory => {
        // ONE pass over the log for the whole batch: the per-note door folded the entire knowledge
        // log each time, so archiving N notes cost N reads and N folds.
        const retiring = goes.flatMap(c => {
          const n = byKey.get(c.key)
          return n ? [{ id: n.id, scope: n.scope }] : []
        })
        await memory.store.setArchivedAll(retiring, true, await cliAuthor())
        await memory.projector.catchUp()
      })
      console.log(`archived ${goes.length} note(s) — restore any with: orc memory restore <id> --scope <scope>`)
    })
  mem
    .command('archive <id>')
    .description('retire ONE note by id — the escape hatch when evidence cannot reach it')
    .option('--scope <scope>', 'the note\'s scope (default: project)')
    .action(async (id: string, o: { scope?: string }) => {
      const { config, log } = needPlugin()
      // `recheck --apply` archives what the EVIDENCE reaches; this reaches the rest. A note whose
      // provenance was damaged (an old archive/restore that overwrote its author before that was
      // fixed) has no evidence left to retire it by, and without this it could never be retired.
      await withMemory({ log, config }, async memory => {
        await memory.store.setArchived(id, o.scope ?? 'project', true, await cliAuthor())
        await memory.projector.catchUp()
      })
      console.log(`archived '${id}' — restore with: orc memory restore ${id} --scope ${o.scope ?? 'project'}`)
    })
  mem
    .command('restore <id>')
    .description('bring an archived note back into the read model')
    .option('--scope <scope>', 'the note\'s scope (default: project)')
    .action(async (id: string, o: { scope?: string }) => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        await memory.store.setArchived(id, o.scope ?? 'project', false, await cliAuthor())
        await memory.projector.catchUp()
      })
      console.log(`restored '${id}'`)
    })
  mem
    .command('frontier')
    // "candidates", not "the edge": the formula (plugins/memory/src/frontier.ts) is an unvalidated
    // [conjecture] ranking by link shape alone — the description must not assert a conclusion the
    // read-out has not earned. See the printed qualifier below for the same honesty at the point a
    // human actually reads it.
    .description('notes that link out more than in, by link shape alone — unvalidated candidates, not a verdict')
    .option('--limit <n>', 'how many to show (default 10)', parsePositiveInteger)
    .action(async (o: { limit?: number }) => {
      const { log } = needPlugin()
      // pure fold, like sweep: the frontier is a property of the authored graph, so it needs the
      // log and no read model at all — it is correct even with SurrealDB down.
      const events = await log.after(0, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted])
      const m = foldMemory(events)
      // `note` here is MemoryWrittenPayload's MemoryNoteInput — it carries no updatedAt (that field
      // exists only on the projector's stored/rendered Note). Last-write time lives on the fold's
      // separate `writes` map, the same source sweep.ts's lastTouchedAt reads from.
      const notes = [...m.notes.values()].map(({ note }) => ({
        id: note.id, scope: note.scope, title: note.title, tier: note.tier,
        links: note.links.map(l => l.id), updatedAt: m.writes.get(noteKey(note.scope, note.id)) ?? '',
      }))
      const hits = frontier(notes, new Date().toISOString(), { limit: o.limit ?? 10 })
      // frontier.ts's own top comment carries the full reasoning; this is the one line of it that
      // reaches a human looking at the terminal rather than the source. Counted live off the fold,
      // not quoted as a number in prose, so the caveat cannot go stale the way a hardcoded count would.
      const scored = notes.filter(n => n.tier === NOTE_TIER.semantic).length
      console.log(`_link shape only, over ${scored} semantic note(s) — not checked against any real retrieval miss; at this size a link or two flips the order_`)
      if (hits.length === 0) {
        console.log('_no note points at more than points back at it — nothing is obviously under-developed_')
        return
      }
      for (const h of hits)
        console.log(`${h.scope}/${h.id}\t${h.title}\tout ${h.out}\tin ${h.in}\tscore ${h.score.toFixed(2)}`)
    })
  mem
    .command('ls')
    .description('list memory notes')
    .option('--category <c>', 'filter by category')
    .option('--tag <t>', 'filter by tag')
    .option('--tier <t>', `only one memory lane: ${NOTE_TIERS.join(' | ')}`, parseNoteTier)
    .action(async (o: { category?: string; tag?: string; tier?: NoteTier }) => {
      const { config, log } = needPlugin()
      const rows = await withMemory({ log, config }, async memory => {
        await memory.projector.catchUp()
        return memory.store.list({ category: o.category, tag: o.tag, tier: o.tier })
      })
      // the agent path already says "absence is not proof a decision doesn't exist"; printing
      // zero bytes gives the human strictly less than the model gets, and reads as "no such note"
      // when the honest answer is "the read model returned nothing"
      if (rows.length === 0) console.log('_no notes_')
      // hits is the observed hot/cold split — the only evidence for whether a decay/sweep policy
      // would ever be tuned against data rather than guessed at.
      for (const n of rows) console.log(`${n.id}\t${n.tier}\t${n.title}\t[${n.categories.join(',')}]\thits ${n.hits}\t${n.summary}`)
    })
  mem
    .command('search <query>')
    .description('search memory notes by meaning + keyword (hybrid; keyword-only if no embedder is configured)')
    .action(async (query: string) => {
      const { config, log } = needPlugin()
      const rows = await withMemory({ log, config }, async memory => {
        await memory.projector.catchUp()
        return memory.store.search(query)
      })
      if (rows.length === 0) console.log('_no notes_')
      for (const n of rows) console.log(`${n.id}\t${n.title}\t${n.summary}`)
    })
  mem
    .command('cat <id>')
    .description('print a memory note as JSON')
    .option('--scope <s>', 'scope')
    .action(async (id: string, o: { scope?: string }) => {
      const { config, log } = needPlugin()
      const n = await withMemory({ log, config }, async memory => {
        await memory.projector.catchUp()
        const note = await memory.store.get(id, o.scope)
        // a human read counts the same as an agent read — but only on a hit, and only after the
        // note was actually produced (same rule the memory_read tool follows). No catchUp: the
        // append is durable, and every read path already drains before it reads.
        if (note) await memory.store.recordAccess(id, o.scope, MEMORY_ACCESS.read, await cliAuthor())
        return note
      })
      if (!n) throw new Error(`no note '${id}'`)
      console.log(JSON.stringify(n, null, 2))
    })
  mem
    .command('claims <id>')
    .description("list a note's live claims, or --history to include ones it has retired")
    .option('--scope <s>', 'scope')
    .option('--history', 'fold the log for retired claims and the write that retired each')
    .option('--json', 'raw live claims (scripts), or the raw folded history when --history is given')
    .action(async (id: string, o: { scope?: string; history?: boolean; json?: boolean }) => {
      const { config, log } = needPlugin()
      const scope = o.scope ?? MemoryScope.project
      await withMemory({ log, config }, async memory => {
        if (!o.history) {
          // claims live in the derived read model, so drain first — same rule every other read
          // command follows. Without it a claim written moments ago reads back as "no claims",
          // which this branch reports as an ERROR rather than as staleness.
          await memory.projector.catchUp()
          const live = await memory.store.claimsFor(id, scope)
          // --json is for scripts: emit the raw Claim[] and stop. An empty result is [] and exit 0
          // here, the rule `topics --json` already settled — a script wants absence as DATA, not a
          // thrown diagnostic it has to parse. Deliberately ahead of the human throw below, which
          // stays exactly as it was because it names a note a person can go and read.
          if (o.json) { console.log(JSON.stringify(live, null, 2)); return }
          if (live.length === 0) throw new Error(`no claims on '${id}' (scope ${scope}) — 'orc memory cat ${id}' to see the note`)
          for (const c of live) console.log(`${c.id}  ${c.validFrom}  ${c.text}`)
          return
        }
        // History comes from the LOG, not the read model: the note payload carries live claims only,
        // so a retired claim exists nowhere else. Ordered by seq, which claimHistory requires.
        // memory_deleted travels with memory_written because deleting a note ends its claims'
        // stretches too — the projector drops their rows, so a fold that saw only writes would
        // report a deleted note's claims as live forever.
        const events = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_written || e.kind === EVENT_KIND.memory_deleted)
        const folded = claimHistory(events.flatMap(e => {
          if (e.kind === EVENT_KIND.memory_deleted) {
            const d = MemoryDeletedPayload.safeParse(e.payload)
            if (!d.success || d.data.id !== id || d.data.scope !== scope) return []
            return [{ ts: e.ts, claims: [], invalidates: [], deleted: true }]
          }
          const p = MemoryWrittenPayload.safeParse(e.payload)
          if (!p.success || p.data.note.id !== id || p.data.note.scope !== scope) return []
          const n: NoteFields = p.data.note
          return [{ ts: e.ts, claims: n.claims ?? [], invalidates: p.data.invalidates }]
        }))
        // same rule on the history form: one parseable JSON value (the folded claims, tombstones
        // and all), never JSON followed by human rows
        if (o.json) { console.log(JSON.stringify(folded, null, 2)); return }
        if (folded.length === 0) throw new Error(`no claims in the log for '${id}' (scope ${scope})`)
        for (const c of folded)
          console.log(`${c.id}  ${c.validFrom}  ${c.invalidatedAt ? `RETIRED ${c.invalidatedAt}` : 'live'}  ${c.text}`)
      })
    })
  mem
    .command('topics [topicKey]')
    .description("derived topics over project claims (statements grouped by meaning); pass a key to list that topic's claims")
    .option('--json', 'raw topic inventory (scripts), or the raw claims of one topic when a key is given')
    .action(async (topicKey: string | undefined, o: { json?: boolean }) => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        // topics are refreshed by the projector's drain — read after catching up, or the listing
        // (and the keys it hands out) can reflect a stale partition.
        await memory.projector.catchUp()
        if (topicKey === undefined) {
          const topics = await memory.store.topics()
          // --json is for scripts: emit the raw Topic[] and stop. An empty inventory is [] and
          // exit 0 here (a script wants absence as data, not a thrown diagnostic) — deliberately
          // NOT the human throw below, which names the causes a person can act on.
          if (o.json) { console.log(JSON.stringify(topics, null, 2)); return }
          // an empty listing is silence an operator can't act on; name every cause — topics are
          // derived from claim embeddings, so no claims or no embedder both land here, and a
          // pre-claims corpus has no claim rows at all until something writes some (the legacy
          // rules[] decoder that used to synthesise them is gone, so a rebuild will not conjure
          // them either — this is the cause an operator upgrading onto claims actually hits).
          if (topics.length === 0) throw new Error('no topics — write some claims, or check an embedder is configured; a corpus written before claims existed has none until an agent states some via memory_write addClaims (the legacy rules[] decoder that used to synthesise them is gone, so `orc memory rebuild` will not produce them either)')
          for (const t of topics) console.log(`${t.topicKey}  ${String(t.size).padStart(3)}  ${t.label}`)
          return
        }
        // topicClaims throws on an unknown key with a 'list topics again' message — surfaced as-is
        // by the CLI's error path, not caught here. It also appends memory_topic_accessed exactly
        // once, so the --json branch reads THROUGH it rather than around it: the access event is
        // recorded whether the caller wants JSON or human rows.
        const claims = await memory.store.topicClaims(topicKey, await cliAuthor())
        // --json: raw Claim[] and stop, no human rows (stdout stays one parseable JSON value).
        if (o.json) { console.log(JSON.stringify(claims, null, 2)); return }
        for (const c of claims)
          console.log(`${c.id}  ${c.validFrom}  ${c.text}`)
      })
    })
  mem
    .command('neighbors <id>')
    .description('traverse typed links from a seed note (ranked blast radius)')
    .option('--kinds <k...>', 'only follow these link kinds')
    .option('--depth <n>', 'max hops (default 2)', parsePositiveInteger)
    .option('--scope <s>', 'scope')
    .action(async (id: string, o: { kinds?: string[]; depth?: number; scope?: string }) => {
      // One pass through the shared enumArg: validates AND narrows, where this used to check in a
      // loop and then re-parse through zod to get the type without a cast. A friendly error beats
      // the store silently ignoring an unknown kind, which reads as "no neighbors".
      const kinds = o.kinds?.map(k => enumArg<LinkKind>('--kinds', LINK_KINDS)(k))
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        await memory.projector.catchUp()
        const ranked = await memory.store.neighbors(id, { kinds, depth: o.depth, scope: o.scope })
        // mirror the memory_neighbors MCP tool: one access against the SEED, only on a hit —
        // the neighbours are summaries the caller may never read.
        if (ranked.length > 0) await memory.store.recordAccess(id, o.scope, MEMORY_ACCESS.neighbors, await cliAuthor())
        // empty prints a sentinel (like ls/search's `_no notes_`) so a human isn't shown zero bytes.
        if (ranked.length === 0) { console.log('_no neighbors_'); return }
        // direction disambiguates asymmetric kinds: '→ supersedes' = seed supersedes n; '← supersedes' = n supersedes seed
        for (const n of ranked) console.log(`${n.id}\t${n.direction === EDGE_DIRECTION.out ? '→' : '←'} ${n.via}\t${n.depth}\t${n.score.toFixed(2)}\tact ${n.activation.toFixed(2)}\t${n.title}`)
      })
    })
  mem
    .command('rebuild')
    .description('rebuild the memory read model from the event log')
    .action(async () => {
      const { config, log } = needPlugin()
      const { degraded } = await withMemory({ log, config }, memory => memory.projector.rebuild())
      if (degraded) {
        console.warn('memory read model rebuilt from the log but is degraded — some notes did not reproject')
      } else {
        console.log('memory read model rebuilt from the log')
      }
    })
  mem
    .command('restamp')
    .description('after MANUALLY committing a healed change, catch notes whose paths are now fully committed up to HEAD so the freshness gate stops reading them drifted (heal → commit → restamp; autoCommit runs do this themselves, scoped to the notes they wrote)')
    .action(async () => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        // one spelling with the auto-heal reactor — restampToHead is the whole pass
        const targets = await restampToHead(memory.store, config.dir, await cliAuthor())
        console.log(targets.length === 0
          ? 'nothing to restamp — no note has fully-committed drift to catch up'
          : `restamped ${targets.length} note(s) to HEAD: ${targets.map(t => t.id).join(', ')}`)
      })
    })
  mem
    .command('consolidate <taskId>')
    .description("distill a task's step notes into one durable project note, linked to the knowledge it used")
    .option('--model <ref>', 'synthesise the note with this model instead of extractive bullets')
    .action(async (taskId: string, opts: { model?: string }) => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        await memory.projector.catchUp()
        const distill = opts.model ? buildDistiller(seedRegistries(config).providers, opts.model) : undefined
        // force: an explicit manual request bypasses the salience gate the auto-lifecycle applies
        // The SAME author shape the lifecycle subscriber builds (runtime.ts) — a consolidation is
        // an agent writer named through `executor`, never a person at a terminal, whichever door
        // asked for it; only the workspace comes from this cwd.
        const author = await cwdAuthor(requireKernel(), config.dir, AUTHOR_SOURCE.agent, { executor: CONSOLIDATE_EXECUTOR })
        const notes = await consolidateTask({ log, store: memory.store, author, distill }, taskId, { force: true })
        if (!notes || notes.length === 0) { console.log(`nothing to consolidate for '${taskId}' — unknown task, planning child, or no step notes`); return }
        await memory.projector.catchUp()
        // one line per note: a multi-area task consolidates into one anchored note per area
        for (const note of notes)
          console.log(`consolidated '${note.id}'${opts.model ? ` (distilled by ${opts.model})` : ''} with ${note.links.length} source link(s) — read it: orc memory cat ${note.id}`)
      })
    })

  program
    .command('note <title>')
    .description("quick capture: write a project knowledge note with NO task/plan/approve ceremony (id = slugged title; noting the same title again updates that note)")
    .option('--summary <text>', 'one-line summary')
    .option('--body <text>', 'note body (markdown)')
    .option('--tags <tags...>', 'tags')
    .action(async (title: string, o: { summary?: string; body?: string; tags?: string[] }) => {
      const { config, log } = needPlugin()
      await withMemory({ log, config }, async memory => {
        const id = slugId(title)
        await memory.store.write({ id, title, summary: o.summary, body: o.body, tags: o.tags }, await cliAuthor())
        await memory.projector.catchUp() // one-shot CLI process: project the append now
        console.log(`noted '${id}' — read it back: orc memory cat ${id}`)
      })
    })

  return program
}
