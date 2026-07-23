import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, InvalidArgumentError } from 'commander'
import { EDGE_DIRECTION, EVENT_KIND, LINK_KINDS, MEMORY_ACCESS, PlanDraft, RUN_OUTCOME, STRATEGY, TASK_STATUS, LinkKind, type Analyzer, type EventRecord, type ExecutionPort, type Plan, type RunHandle } from '@orc/contracts'
import { openStorage, Kernel, fold, grantExtensionTrust, grantMcpTrust, initializeProject, isExtensionTrusted, isMcpTrusted, loadConfig, loadTrust, migrateDatabase, requireProject, taskUsage, type EventLog, type OrcConfig, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'
import { createVaultProjector, parsePlanFile } from '@orc/vault-projector'
import { createMemory, probeMemory } from '@orc/memory'
import { buildModelDiscovery, buildOrcActions, singleStepDraft } from './actions'
import { renderPlanHuman } from './plan-render'

// Providers are ModelProvider<unknown> by design (extensions may register anything) — the
// boundary check validates the shape at runtime instead of casting.
type CopilotModel = ReturnType<import('@orc/graph-ui').CopilotConfig['resolveModel']>
const isLanguageModel = (m: unknown): m is CopilotModel =>
  typeof m === 'string' || (typeof m === 'object' && m !== null && 'specificationVersion' in m)

function buildCopilotConfig(discovery: ReturnType<typeof buildModelDiscovery>) {
  return {
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    listModels: discovery.listModels,
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
  const projectId = opts.projectId ?? requireProject(loadConfig()).projectId
  const storage = await openStorage(url, { projectId, redactEnv: opts.redactEnv })
  const log = storage.events
  if (opts.onAppend) log.onAppend = opts.onAppend
  return { kernel: new Kernel(log, opts.refValidator, opts.analyzers, opts.send), log, storage }
}

const SHIPPED_SKILLS_DIR = fileURLToPath(new URL('../../../vault/skills', import.meta.url))
const SHIPPED_SKILLS = ['codebase-analysis', 'plan-authoring', 'documentation', 'web-research']

// `orc init` must work before Postgres/plugins exist, so it gets a standalone entry
// (bin.ts) and the same command inside buildProgram for help/unit visibility
export function initCommand(dir?: string): Command {
  return new Command('init')
    .description('initialize project identity (writes .orc/config.json — commit it)')
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
      console.log(`initialized project '${identity.projectName}' (${identity.projectId})`)
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

export { singleStepDraft } from './actions' // moved next to the shared OrcActions implementation

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError(`must be a non-negative integer, got '${value}'`)
  return parsed
}

// neighbors --depth must be >= 1: the store default is 2 and rankNeighbors requires a positive
// hop count (depth 0 traverses nothing and silently returns []), so reject it at parse time with
// a clear error rather than letting a 0 look like "no neighbors".
function parsePositiveInteger(value: string): number {
  const parsed = parseNonNegativeInteger(value)
  if (parsed < 1) throw new InvalidArgumentError(`must be a positive integer (>= 1), got '${value}'`)
  return parsed
}

function resolveDraft(task: { title: string; spec: string }, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }, taskId: string, config?: OrcConfig): PlanDraft {
  if (opts.fromVault) {
    if (!config) throw new Error('--from-vault is unavailable in this context')
    const dir = path.join(config.vaultDir, 'tasks', taskId)
    const latest = readdirSync(dir)
      .filter(f => /^plan-v\d+\.md$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
      .at(-1)
    if (!latest) throw new Error(`no plan file in ${dir} — run 'orc vault render ${taskId}' first`)
    return parsePlanFile(readFileSync(path.join(dir, latest), 'utf8'))
  }
  return opts.file
    ? PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8')))
    : singleStepDraft(task, opts.model, opts.skill ?? [], config?.maxIterations)
}

// stream-driven tail (spec §5): no polling — LISTEN/NOTIFY pushes each event as it commits
async function tailUntilDone(kernel: Kernel, taskId: string, handle: RunHandle): Promise<string> {
  const print = (e: EventRecord) => console.log(`${String(e.seq).padStart(4)}  ${e.kind}${e.stepId ? `  ${e.stepId}` : ''}`)
  let lastSeen = Math.max(0, ...(await kernel.eventsFor(taskId)).map(e => e.seq))
  const unsub = await kernel.subscribe({ fromSeq: lastSeen }, e => {
    if (e.taskId === taskId) { print(e); lastSeen = e.seq }
  })
  try {
    return await handle.wait()
  } finally {
    await unsub()
    for (const e of await kernel.eventsSince(taskId, lastSeen)) print(e) // drain final window
  }
}

export function buildProgram(
  kernel: Kernel,
  portFactory?: () => Promise<ExecutionPort>,
  plugin?: { host: PluginHost; hub: McpHub; config: ProjectConfig; log: EventLog; storage?: Storage },
): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')
  program.addCommand(initCommand(plugin?.config.dir))
  program.addCommand(databaseCommand(plugin?.config.dir))

  const needPlugin = () => {
    if (!plugin) throw new Error('plugin commands are unavailable in this context')
    return plugin
  }

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
    .action(async (title: string, opts: { spec: string; parent?: string; strategy?: string; model?: string; analyzer: string }) => {
      if (opts.strategy !== undefined && !(Object.values(STRATEGY) as string[]).includes(opts.strategy))
        throw new Error(`unknown --strategy '${opts.strategy}' — valid strategies: ${Object.values(STRATEGY).join(', ')}`)
      if (opts.strategy !== STRATEGY.groundedPlan) {
        const t = await kernel.createTask({ title, spec: opts.spec, parentId: opts.parent })
        console.log(t.id)
        return
      }
      if (!opts.model) throw new Error(`--model is required with --strategy ${STRATEGY.groundedPlan}`)
      const t = await kernel.createGroundedTask({ title, spec: opts.spec, modelRef: opts.model, analyzerRef: opts.analyzer })
      console.log(t.id)
      // auto-start: the grounded-plan template is policy-approved (its real gate is the
      // conversational one inside the plan step), so the analyze→plan conversation begins now
      const handle = await (await needPort()).startRun(t.id, { cwd: plugin?.config.dir ?? process.cwd() })
      console.log(`run ${handle.workflowId} started — tailing events (ctrl-c stops the run; re-run orc run ${t.id} to resume)`)
      const outcome = await tailUntilDone(kernel, t.id, handle)
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === 'done' ? 0 : 1
    })

  const requireTask = async (taskId: string) => {
    const task = await kernel.getTask(taskId)
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
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .action(planAction((id, draft) => kernel.proposePlan(id, draft), plan => `proposed (${plan.steps.length} steps)`))

  program
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .option('--from-vault', 'read the edited plan markdown from the vault')
    .action(planAction((id, draft) => kernel.editPlan(id, draft), () => 'edited'))

  // per-MTok rate for the gate: the human weighs spend BEFORE approving. Best-effort —
  // no provider/discovery (read-only context, unknown ref) renders without a rate.
  const rateFor = (ref: string): string | null => {
    if (!discovery) return null
    try {
      const { p, modelId } = discovery.providerFor(ref)
      const c = p.costs[modelId] ?? p.costs['*']
      return c ? `$${c.inPerMTok}/M in · $${c.outPerMTok}/M out` : null
    } catch { return null }
  }

  program
    .command('plan <taskId>')
    .description('show a plan for review (latest by default; --json for the raw draft)')
    .option('--version <n>', 'plan version', parseNonNegativeInteger)
    .option('--json', 'raw plan JSON (scripts; the full field set)')
    .action(async (taskId: string, opts: { version?: number; json?: boolean }) => {
      const plan = await kernel.getPlan(taskId, opts.version)
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
      const plan = await kernel.approvePlan(taskId, opts.version)
      console.log(`plan v${plan.version} approved`)
    })

  program
    .command('plan-note <taskId> <noteId> <text>')
    .description('annotate a plan-note (grounded-plan) — the plan-authoring agent reads it on its next revise')
    .option('--ref <ids...>', 'related plan-note ids')
    .action(async (taskId: string, noteId: string, text: string, opts: { ref?: string[] }) => {
      await kernel.annotatePlan(taskId, { targetNote: noteId, refs: opts.ref ?? [], text })
      console.log(`noted on '${noteId}'`)
    })

  program
    .command('reply <taskId> <text>')
    .description("answer a task's open feedback question (e.g. 'orc reply <taskId> approve'), resuming the waiting step")
    .action(async (taskId: string, text: string) => {
      // DBOS.send (behind kernel.send) requires DBOS launched in THIS process — reply typically
      // runs in a fresh CLI invocation, separate from the `orc run` it's answering, so the port
      // must be brought up here first, exactly like run/retry/cancel do.
      await needPort()
      const topic = await kernel.replyFeedback(taskId, text)
      console.log(topic ? `answered feedback:${topic}` : `no open feedback question for task '${taskId}'`)
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
    .command('purge')
    .description("cancel running work and delete this project's events, operations, and memory read model — identity stays (clean slate for re-testing)")
    .requiredOption('--yes', 'confirm: this irreversibly deletes the project history')
    .action(async () => {
      const r = await actions().purgeProject()
      console.log(`purged ${r.events} event(s), ${r.operations} operation(s)`)
      for (const w of r.warnings) console.log(`warning: ${w}`)
    })

  program
    .command('tasks')
    .description('list tasks')
    .action(async () => {
      const tasks = await kernel.listTasks()
      if (tasks.length === 0) console.log('_no tasks_')
      for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(17)} ${t.title}`)
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .option('--json', 'full redacted event records as JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      await requireTask(taskId)
      const events = await kernel.eventsFor(taskId)
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
      const all = await kernel.eventsFor(taskId)
      const at = opts.at ?? Number.POSITIVE_INFINITY
      const events = all.filter(e => e.seq <= at)
      if (events.length === 0 && all.length > 0) {
        // an empty fold here is a footgun, not data: --at is below this task's first event
        console.error(`no events for '${taskId}' at or before seq ${opts.at} — sequences are GLOBAL across the project log; this task's events span ${all[0]!.seq}..${all.at(-1)!.seq} (orc log ${taskId})`)
        process.exitCode = 1
        return
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
  const actions = () => buildOrcActions({ kernel, needPort, plugin, listModels: discovery?.listModels })

  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw new Error('execution commands are unavailable in this context')
    return portFactory()
  }

  const execAction = (start: (port: ExecutionPort, taskId: string, cwd?: string) => Promise<RunHandle>, intro: (h: RunHandle, taskId: string) => string) =>
    async (taskId: string, opts: { cwd?: string }) => {
      const handle = await start(await needPort(), taskId, opts.cwd)
      console.log(intro(handle, taskId))
      // A DBOS-cancelled workflow's getResult() REJECTS (split-run.test.ts:245 notes it may
      // resolve or reject). `orc cancel` from another terminal is an advertised path — the intro
      // line promises ctrl-c stops the run — so surfacing it as a raw driver error and exit 1 is
      // indistinguishable from a crash, while `orc status` correctly reads 'cancelled'.
      const outcome = await tailUntilDone(kernel, taskId, handle).catch(async err => {
        const status = (await kernel.getTask(taskId))?.status
        if (status === TASK_STATUS.cancelled) return RUN_OUTCOME.cancelled
        throw err
      })
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === RUN_OUTCOME.done ? 0 : 1
    }

  program
    .command('run <taskId>')
    .description('execute the approved plan (durable; re-run attaches/resumes)')
    .option('--cwd <dir>', 'shared workspace for all steps (default: the project directory)')
    .action(execAction(
      (port, taskId, cwd) => port.startRun(taskId, { cwd }),
      (h, taskId) => `run ${h.workflowId} started — tailing events (ctrl-c stops the run; re-run orc run ${taskId} to resume)`,
    ))

  program
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>', "workspace override (default: the previous run's cwd, else the project directory)")
    .action(execAction(
      (port, taskId, cwd) => port.retry(taskId, { cwd }),
      h => `retry ${h.workflowId} started`,
    ))

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
    .description('serve the live project graph UI (read-only, 127.0.0.1)')
    .option('--port <n>', 'port', (v: string) => parseInt(v, 10), 7749)
    .action(async (opts: { port: number }) => {
      const { startGraphUi } = await import('@orc/graph-ui') // lazy: keep CLI startup lean
      const cfg = plugin?.config
      const ui = startGraphUi({
        url: (cfg ?? loadConfig()).databaseUrl,
        port: opts.port,
        cwdProject: cfg ? { id: cfg.projectId, name: cfg.projectName, dir: cfg.dir } : undefined,
        // mutations only when launched inside a project with a real runtime behind it
        actions: portFactory && plugin ? actions() : undefined,
        copilot: portFactory && plugin && discovery ? buildCopilotConfig(discovery) : undefined,
        defaultCwd: cfg?.dir ?? process.cwd(),
        // degraded-memory visibility (P3): the footer badge polls this — probe per call, no cache
        health: plugin ? async () => ({ memory: await probeMemory(plugin.config, plugin.log) }) : undefined,
        // P6: copilot exchanges are events — the log is the record, the browser is a cache
        appendExchange: plugin ? async x => {
          await plugin.log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.copilot_exchange, payload: x.payload, usage: x.usage })
        } : undefined,
      })
      console.log(`graph ui on http://127.0.0.1:${ui.port}`)
      await new Promise(() => {}) // serve until Ctrl-C
    })

  program
    .command('status <taskId>')
    .description('per-step state and cost totals')
    .action(async (taskId: string) => {
      const state = await kernel.state()
      const task = state.tasks.get(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      if (plugin) {
        console.log(`project: ${plugin.config.projectName} (${plugin.config.projectId})`)
        const health = await probeMemory(plugin.config, plugin.log)
        console.log(health.healthy ? 'memory: healthy' : `memory: degraded (${health.reason})`)
      }
      console.log(`${task.id}  ${task.status}  ${task.title}`)
      const plan = state.plans.get(taskId)?.versions.at(-1)
      for (const step of plan?.steps ?? []) {
        const s = state.steps.get(taskId)?.get(step.id)
        const status = s?.status ?? 'pending'
        const detail = s?.failure ? `  [${s.failure.class}] ${s.failure.message}` : (s?.output ? `  → ${s.output}` : '')
        console.log(`  ${step.id.padEnd(12)} ${status.padEnd(10)} attempt ${s?.attempt ?? 0}${detail}`)
      }
      // D3: a grounded task shows what its analysis covered — and the gaps it did NOT (RG7 honesty).
      const coverage = await kernel.latestCoverage(taskId)
      if (coverage)
        console.log(`  analysis: ${coverage.analyzed ? `${coverage.notesWritten} notes, confidence ${coverage.confidence}` : 'not analyzed'}${coverage.gaps.length ? `  gaps: ${coverage.gaps.join(', ')}` : ''}`)
      // D4 gate, human side: a grounded-plan step parked on ask_human shows its question here, so the
      // conversation isn't one-directional — the human sees the prompt, not just a blind reply target.
      const feedback = await kernel.openFeedback(taskId)
      if (feedback) console.log(`  awaiting reply: ${feedback.question}  (orc reply ${taskId} <text>)`)
      const ops = [...state.operations.values()]
        .filter(o => o.taskId === taskId)
        .sort((a, b) => a.startedSeq - b.startedSeq)
      for (const o of ops)
        console.log(`  op  ${o.kind.padEnd(6)} ${o.name.padEnd(24)} ${o.status.padEnd(10)} attempts ${o.attempts}`)
      for (const a of state.artifacts.get(taskId) ?? [])
        console.log(`  out ${(a.stepId ?? '?').padEnd(12)} ${a.path} · sha256:${a.sha256.slice(0, 12)}… · ${a.size}B`)
      const u = taskUsage(state, taskId)
      const cache = u.cacheReadTokens || u.cacheWriteTokens
        ? `  cache r/w: ${u.cacheReadTokens ?? 0}/${u.cacheWriteTokens ?? 0}`
        : '' // no cache split recorded for this task
      console.log(`  tokens in/out: ${u.inputTokens}/${u.outputTokens}${cache}  cost: ${u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`}`)
    })

  program
    .command('skills')
    .description('list indexed skills (vault/skills)')
    .action(async () => {
      const { host } = needPlugin()
      for (const e of host.skills.list()) {
        const mark = e.valid ? 'ok     ' : 'INVALID'
        const desc = e.valid ? (e.manifest!.description.length > 80 ? `${e.manifest!.description.slice(0, 77)}...` : e.manifest!.description) : e.errors.join('; ')
        console.log(`${mark} ${e.name.padEnd(24)} ${desc}`)
      }
    })

  const vault = program.command('vault').description('OKF vault projection')
  vault
    .command('render [taskId]')
    .description('render the vault from the event log (all tasks if omitted)')
    .action(async (taskId?: string) => {
      const { config, log } = needPlugin()
      if (taskId && !(await kernel.getTask(taskId))) throw new Error(`no task '${taskId}'`)
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
      const { config, log } = needPlugin()
      const { startMcpServe } = await import('./mcp-serve') // lazy: the SDK loads only here
      await startMcpServe({
        config, log,
        actions: portFactory ? actions() : null,
        autonomy: opts.autonomy,
      })
    })
  mcp
    .command('list')
    .description('declared servers and their trust state')
    .action(async () => {
      const { config } = needPlugin()
      const trust = loadTrust(config.dir) // fresh read: grants take effect in the same session's list
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
      grantMcpTrust(serverId, declared, config.dir)
      console.log(`trusted mcp server '${serverId}' (bound to its current command/args/env declaration)`)
    })

  const ext = program.command('ext').description('T2 extensions')
  ext
    .command('list')
    .description('declared extensions and their trust state')
    .action(async () => {
      const { host, config } = needPlugin()
      const trust = loadTrust(config.dir) // fresh read: grants take effect in the same session's list
      for (const p of config.extensions) {
        const state = isExtensionTrusted(trust, p, config.dir) ? 'trusted  ' : 'untrusted'
        const active = host.extensions.loaded.find(l => l.path === path.resolve(config.dir, p))
        console.log(`${state} ${p}${active ? `  (loaded: ${active.manifest.id})` : ''}`)
      }
    })
  ext
    .command('trust <path>')
    .description('grant local trust to a declared extension')
    .action(async (p: string) => {
      const { config } = needPlugin()
      if (!config.extensions.some(e => path.resolve(config.dir, e) === path.resolve(config.dir, p)))
        throw new Error(`undeclared extension '${p}' — declare it in .orc/config.json first`)
      grantExtensionTrust(p, config.dir)
      console.log(`trusted extension '${p}' (bound to its current content) — takes effect on the next orc invocation`)
    })

  const mem = program.command('memory').description('project knowledge graph (M4b)')
  mem
    .command('add')
    .description('write or update a memory note')
    .requiredOption('--id <id>', 'note id')
    .requiredOption('--title <title>', 'note title')
    .option('--summary <s>', 'short summary')
    .option('--body <b>', 'note body (markdown)')
    .option('--tags <tags...>', 'tags')
    .option('--categories <categories...>', 'categories')
    .action(async (o: { id: string; title: string; summary?: string; body?: string; tags?: string[]; categories?: string[] }) => {
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      await memory.store.write({
        id: o.id, title: o.title, summary: o.summary, body: o.body,
        tags: o.tags, categories: o.categories,
      }, { source: 'cli' })
      await memory.projector.catchUp() // one-shot: no live subscription in a CLI process, so project the append now
      await memory.close()
      console.log(`wrote memory '${o.id}'`)
    })
  mem
    .command('rm <id>')
    .description('delete a memory note')
    .option('--scope <s>', 'scope')
    .action(async (id: string, o: { scope?: string }) => {
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      await memory.store.remove(id, o.scope)
      await memory.projector.catchUp()
      await memory.close()
      console.log(`deleted '${id}'`)
    })
  mem
    .command('ls')
    .description('list memory notes')
    .option('--category <c>', 'filter by category')
    .option('--tag <t>', 'filter by tag')
    .action(async (o: { category?: string; tag?: string }) => {
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      await memory.projector.catchUp()
      const rows = await memory.store.list({ category: o.category, tag: o.tag })
      await memory.close()
      // the agent path already says "absence is not proof a decision doesn't exist"; printing
      // zero bytes gives the human strictly less than the model gets, and reads as "no such note"
      // when the honest answer is "the read model returned nothing"
      if (rows.length === 0) console.log('_no notes_')
      // hits is the observed hot/cold split — the only evidence for whether a decay/sweep policy
      // would ever be tuned against data rather than guessed at.
      for (const n of rows) console.log(`${n.id}\t${n.title}\t[${n.categories.join(',')}]\thits ${n.hits}\t${n.summary}`)
    })
  mem
    .command('search <query>')
    .description('full-text search memory notes')
    .action(async (query: string) => {
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      await memory.projector.catchUp()
      const rows = await memory.store.search(query)
      await memory.close()
      if (rows.length === 0) console.log('_no notes_')
      for (const n of rows) console.log(`${n.id}\t${n.title}\t${n.summary}`)
    })
  mem
    .command('cat <id>')
    .description('print a memory note as JSON')
    .option('--scope <s>', 'scope')
    .action(async (id: string, o: { scope?: string }) => {
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      await memory.projector.catchUp()
      const n = await memory.store.get(id, o.scope)
      // a human read counts the same as an agent read — but only on a hit, and only after the
      // note was actually produced (same rule the memory_read tool follows). No catchUp: the
      // append is durable, and every read path already drains before it reads.
      if (n) await memory.store.recordAccess(id, o.scope, MEMORY_ACCESS.read, { source: 'cli' })
      await memory.close()
      if (!n) throw new Error(`no note '${id}'`)
      console.log(JSON.stringify(n, null, 2))
    })
  mem
    .command('neighbors <id>')
    .description('traverse typed links from a seed note (ranked blast radius)')
    .option('--kinds <k...>', 'only follow these link kinds')
    .option('--depth <n>', 'max hops (default 2)', parsePositiveInteger)
    .option('--scope <s>', 'scope')
    .action(async (id: string, o: { kinds?: string[]; depth?: number; scope?: string }) => {
      // validate --kinds against the known link kinds the way `new --strategy` does — a friendly
      // error beats the store silently ignoring an unknown kind (which reads as "no neighbors").
      if (o.kinds) for (const k of o.kinds)
        if (!(LINK_KINDS as readonly string[]).includes(k))
          throw new Error(`unknown --kinds '${k}' — valid kinds: ${LINK_KINDS.join(', ')}`)
      // parse at the boundary, never cast — the loop above guarantees this cannot throw
      const kinds = o.kinds?.map(k => LinkKind.parse(k))
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      try {
        await memory.projector.catchUp()
        const ranked = await memory.store.neighbors(id, { kinds, depth: o.depth, scope: o.scope })
        // mirror the memory_neighbors MCP tool: one access against the SEED, only on a hit —
        // the neighbours are summaries the caller may never read.
        if (ranked.length > 0) await memory.store.recordAccess(id, o.scope, MEMORY_ACCESS.neighbors, { source: 'cli' })
        // empty prints a sentinel (like ls/search's `_no notes_`) so a human isn't shown zero bytes.
        if (ranked.length === 0) { console.log('_no neighbors_'); return }
        // direction disambiguates asymmetric kinds: '→ supersedes' = seed supersedes n; '← supersedes' = n supersedes seed
        for (const n of ranked) console.log(`${n.id}\t${n.direction === EDGE_DIRECTION.out ? '→' : '←'} ${n.via}\t${n.depth}\t${n.score.toFixed(2)}\tact ${n.activation.toFixed(2)}\t${n.title}`)
      } finally {
        await memory.close()
      }
    })
  mem
    .command('rebuild')
    .description('rebuild the memory read model from the event log')
    .action(async () => {
      const { config, log } = needPlugin()
      const memory = await createMemory({ log, config })
      await memory.projector.rebuild()
      await memory.close()
      console.log('memory read model rebuilt from the log')
    })

  return program
}
