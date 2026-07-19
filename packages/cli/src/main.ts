import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { ISOLATION_TIER, PlanDraft, STRATEGY, type Analyzer, type EventRecord, type ExecutionPort, type Plan, type RunHandle } from '@orc/contracts'
import { openStorage, Kernel, fold, grantExtensionTrust, grantMcpTrust, initializeProject, isExtensionTrusted, isMcpTrusted, loadConfig, loadTrust, requireProject, taskUsage, type EventLog, type OrcConfig, type PluginHost, type ProjectConfig, type Storage } from '@orc/kernel'
import { createVaultProjector, parsePlanFile } from '@orc/vault-projector'
import { createMemory, probeMemory } from '@orc/memory'
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
    send?: (workflowId: string, message: string, topic: string) => Promise<void>
    onAppend?: (e: EventRecord) => void
  } = {},
): Promise<{ kernel: Kernel; log: EventLog; storage: Storage }> {
  const projectId = opts.projectId ?? requireProject(loadConfig()).projectId
  const storage = await openStorage(url, { projectId, redactEnv: opts.redactEnv })
  const log = storage.events
  if (opts.onAppend) log.onAppend = opts.onAppend
  return { kernel: new Kernel(log, opts.refValidator, opts.analyzers, opts.send), log, storage }
}

// `orc init` must work before Postgres/plugins exist, so it gets a standalone entry
// (bin.ts) and the same command inside buildProgram for help/unit visibility
export function initCommand(dir?: string): Command {
  return new Command('init')
    .description('initialize project identity (writes .orc/config.json — commit it)')
    .requiredOption('--name <name>', 'project name')
    .option('--force', 'mint a new identity for a deliberate fork of an existing project')
    .action((opts: { name: string; force?: boolean }) => {
      const identity = initializeProject(dir ?? process.cwd(), opts.name, { force: opts.force })
      console.log(`initialized project '${identity.projectName}' (${identity.projectId})`)
    })
}

export async function runInit(args: string[], dir?: string): Promise<void> {
  await initCommand(dir).parseAsync(args, { from: 'user' })
}

export function singleStepDraft(task: { title: string; spec: string }, modelRef: string, skillRefs: string[] = []): PlanDraft {
  return {
    strategyRef: STRATEGY.single,
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role: 'worker',
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs,
      toolRefs: [],
      isolation: ISOLATION_TIER.local, // the only implemented tier — worktree/docker come with sandbox plugins
      zone: [],
      maxIterations: 25,
      dependsOn: [],
    }],
  }
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
    : singleStepDraft(task, opts.model, opts.skill ?? [])
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
  plugin?: { host: PluginHost; hub: McpHub; config: ProjectConfig; log: EventLog },
): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')
  program.addCommand(initCommand(plugin?.config.dir))

  const needPlugin = () => {
    if (!plugin) throw new Error('plugin commands are unavailable in this context')
    return plugin
  }

  program
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .option('--strategy <s>', `bootstrap strategy ('${STRATEGY.groundedPlan}' starts an analyze→plan conversation instead of a bare draft task)`)
    .option('--model <ref>', `model for the grounded-plan analyze/plan steps (required with --strategy ${STRATEGY.groundedPlan})`)
    .option('--analyzer <ref>', 'analyzer for the grounded-plan analyze step', 'agent-analyzer')
    .action(async (title: string, opts: { spec: string; parent?: string; strategy?: string; model?: string; analyzer: string }) => {
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
      const handle = await (await needPort()).startRun(t.id, {})
      console.log(`run ${handle.workflowId} started — tailing events (ctrl-c stops the run; re-run orc run ${t.id} to resume)`)
      const outcome = await tailUntilDone(kernel, t.id, handle)
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === 'done' ? 0 : 1
    })

  const planAction = (apply: (taskId: string, draft: PlanDraft) => Promise<Plan>, describe: (plan: Plan) => string) =>
    async (taskId: string, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }) => {
      const task = await kernel.getTask(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      const plan = await apply(taskId, resolveDraft(task, opts, taskId, plugin?.config))
      console.log(`plan v${plan.version} ${describe(plan)} — review with: orc plan ${taskId}`)
    }

  program
    .command('propose <taskId>')
    .description('propose a plan (default: single-step template)')
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

  program
    .command('plan <taskId>')
    .description('show a plan (latest by default)')
    .option('--version <n>', 'plan version')
    .action(async (taskId: string, opts: { version?: string }) => {
      const plan = await kernel.getPlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      if (!plan) throw new Error(`no plan for task '${taskId}'`)
      console.log(JSON.stringify(plan, null, 2))
    })

  program
    .command('approve <taskId>')
    .description('approve the latest plan (the human gate)')
    .option('--version <n>', 'expected version (fails if stale)')
    .action(async (taskId: string, opts: { version?: string }) => {
      const plan = await kernel.approvePlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
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
    .command('tasks')
    .description('list tasks')
    .action(async () => {
      for (const t of await kernel.listTasks())
        console.log(`${t.id}  ${t.status.padEnd(17)} ${t.title}`)
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .option('--json', 'full redacted event records as JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
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
    .option('--at <seq>', 'replay up to and including this sequence')
    .action(async (taskId: string, opts: { at?: string }) => {
      const at = opts.at === undefined ? Number.POSITIVE_INFINITY : Number(opts.at)
      if (opts.at !== undefined && (!Number.isInteger(at) || at < 0))
        throw new Error(`--at must be a non-negative integer, got '${opts.at}'`)
      const events = (await kernel.eventsFor(taskId)).filter(e => e.seq <= at)
      const state = fold(events)
      console.log(JSON.stringify(
        state,
        (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value),
        2,
      ))
    })

  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw new Error('execution commands are unavailable in this context')
    return portFactory()
  }

  const execAction = (start: (port: ExecutionPort, taskId: string, cwd?: string) => Promise<RunHandle>, intro: (h: RunHandle, taskId: string) => string) =>
    async (taskId: string, opts: { cwd?: string }) => {
      const handle = await start(await needPort(), taskId, opts.cwd)
      console.log(intro(handle, taskId))
      const outcome = await tailUntilDone(kernel, taskId, handle)
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === 'done' ? 0 : 1
    }

  program
    .command('run <taskId>')
    .description('execute the approved plan (durable; re-run attaches/resumes)')
    .option('--cwd <dir>', 'shared workspace for all steps (default: per-step .orc/workspaces/)')
    .action(execAction(
      (port, taskId, cwd) => port.startRun(taskId, { cwd }),
      (h, taskId) => `run ${h.workflowId} started — tailing events (ctrl-c stops the run; re-run orc run ${taskId} to resume)`,
    ))

  program
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>')
    .action(execAction(
      (port, taskId, cwd) => port.retry(taskId, { cwd }),
      h => `retry ${h.workflowId} started`,
    ))

  program
    .command('cancel <taskId>')
    .description('cancel the active run (terminal in M2)')
    .action(async (taskId: string) => {
      await (await needPort()).cancelRun(taskId)
      console.log('cancelled')
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
      const ops = [...state.operations.values()]
        .filter(o => o.taskId === taskId)
        .sort((a, b) => a.startedSeq - b.startedSeq)
      for (const o of ops)
        console.log(`  op  ${o.kind.padEnd(6)} ${o.name.padEnd(24)} ${o.status.padEnd(10)} attempts ${o.attempts}`)
      for (const a of state.artifacts.get(taskId) ?? [])
        console.log(`  out ${(a.stepId ?? '?').padEnd(12)} ${a.path} · sha256:${a.sha256.slice(0, 12)} · ${a.size}B`)
      const u = taskUsage(state, taskId)
      console.log(`  tokens in/out: ${u.inputTokens}/${u.outputTokens}  cost: ${u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`}`)
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

  const mcp = program.command('mcp').description('MCP servers (T1 plugins)')
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
      for (const n of rows) console.log(`${n.id}\t${n.title}\t[${n.categories.join(',')}]\t${n.summary}`)
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
      await memory.close()
      console.log(n ? JSON.stringify(n, null, 2) : `no note '${id}'`)
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
