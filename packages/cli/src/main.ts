import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { ISOLATION_TIER, PlanDraft, type EventRecord, type ExecutionPort, type Plan, type RunHandle } from '@orc/contracts'
import { EventLog, Kernel, grantTrust, loadConfig, taskUsage, type OrcConfig, type PluginHost } from '@orc/kernel'
import { createVaultProjector, parsePlanFile } from '@orc/vault-projector'
import type { McpHub } from '@orc/mcp-client'

// loadConfig is the ONE resolution of env → .orc/config.json → default; every command
// (read-only or executing) must land on the same database
export async function openKernel(
  url = loadConfig().databaseUrl,
  opts: { refValidator?: (plan: Plan) => Promise<string[]>; onAppend?: (e: EventRecord) => void } = {},
): Promise<{ kernel: Kernel; log: EventLog }> {
  const log = await EventLog.open(url)
  if (opts.onAppend) log.onAppend = opts.onAppend
  return { kernel: new Kernel(log, opts.refValidator), log }
}

export function singleStepDraft(task: { title: string; spec: string }, modelRef: string): PlanDraft {
  return {
    strategyRef: 'template:single',
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role: 'worker',
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs: [],
      toolRefs: [],
      isolation: ISOLATION_TIER.local, // the only implemented tier — worktree/docker come with sandbox plugins
      zone: [],
      maxIterations: 25,
      dependsOn: [],
    }],
  }
}

function resolveDraft(task: { title: string; spec: string }, opts: { file?: string; model: string; fromVault?: boolean }, taskId: string, config?: OrcConfig): PlanDraft {
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
    : singleStepDraft(task, opts.model)
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
  plugin?: { host: PluginHost; hub: McpHub; config: OrcConfig; log: EventLog },
): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')

  const needPlugin = () => {
    if (!plugin) throw new Error('plugin commands are unavailable in this context')
    return plugin
  }

  program
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .action(async (title: string, opts: { spec: string; parent?: string }) => {
      const t = await kernel.createTask({ title, spec: opts.spec, parentId: opts.parent })
      console.log(t.id)
    })

  const planAction = (apply: (taskId: string, draft: PlanDraft) => Promise<Plan>, describe: (plan: Plan) => string) =>
    async (taskId: string, opts: { file?: string; model: string; fromVault?: boolean }) => {
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
    .action(planAction((id, draft) => kernel.proposePlan(id, draft), plan => `proposed (${plan.steps.length} steps)`))

  program
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
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
    .command('tasks')
    .description('list tasks')
    .action(async () => {
      for (const t of await kernel.listTasks())
        console.log(`${t.id}  ${t.status.padEnd(17)} ${t.title}`)
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .action(async (taskId: string) => {
      for (const e of await kernel.eventsFor(taskId))
        console.log(`${String(e.seq).padStart(4)}  ${e.ts}  ${e.kind}`)
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
      console.log(`${task.id}  ${task.status}  ${task.title}`)
      const plan = state.plans.get(taskId)?.versions.at(-1)
      for (const step of plan?.steps ?? []) {
        const s = state.steps.get(taskId)?.get(step.id)
        const status = s?.status ?? 'pending'
        const detail = s?.failure ? `  [${s.failure.class}] ${s.failure.message}` : (s?.output ? `  → ${s.output}` : '')
        console.log(`  ${step.id.padEnd(12)} ${status.padEnd(10)} attempt ${s?.attempt ?? 0}${detail}`)
      }
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

  program
    .command('vault')
    .argument('[taskId]', 'render one task (default: all)')
    .description('render the OKF vault from the event log')
    .action(async (taskId?: string) => {
      const { config, log } = needPlugin()
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
      const { host, config } = needPlugin()
      for (const [id, cfg] of Object.entries(config.mcpServers)) {
        const state = host.trust.mcp.includes(id) ? 'trusted  ' : 'untrusted'
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
      if (!(serverId in config.mcpServers)) throw new Error(`undeclared MCP server '${serverId}' — declare it in .orc/config.json first`)
      grantTrust('mcp', serverId, config.dir)
      console.log(`trusted mcp server '${serverId}'`)
    })

  const ext = program.command('ext').description('T2 extensions')
  ext
    .command('list')
    .description('declared extensions and their trust state')
    .action(async () => {
      const { host, config } = needPlugin()
      for (const p of config.extensions) {
        const state = host.trust.extensions.some(t => path.resolve(config.dir, t) === path.resolve(config.dir, p)) ? 'trusted  ' : 'untrusted'
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
      grantTrust('extensions', p, config.dir)
      console.log(`trusted extension '${p}' — takes effect on the next orc invocation`)
    })

  return program
}
