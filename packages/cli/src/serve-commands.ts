import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Command } from 'commander'
import { Door, type WorkspaceWithHealth } from '@orc/contracts'
import { atomicWriteFileSync, claimSlot, liveSupervisors, loadConfig, staleSupervisors, type ProjectConfig } from '@orc/kernel'
import { buildRuntime } from './runtime'
import { runSupervisor, startBootHeartbeat } from './serve'
import type { buildModelDiscovery } from './actions'
import { findCwdWorkspace } from './cwd-workspace'
import { CommandFailure, EXIT_CODE } from './exit'
import { parsePositiveInteger } from './int-arg'
import { isLanguageModel } from './model-guard'
import { knowledgeHealthLine } from './knowledge-health-line'
import { KNOWLEDGE_HEALTH_TTL_MS, knowledgeHealthOf } from './knowledge-health-of'
import { memoizeFor } from './memoize-for'
import type { ProgramDeps } from './program-deps'
import { serveLogFile, servePidFile } from './serve-paths'
import { probeSupervisor } from './supervisor-probe'
import { untilInterrupted } from './until-interrupted'
import { listWorkspaceHealth } from './workspace-health'

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

// detached on purpose: a supervisor in the CLI's process group would take the watch's ctrl-c
export function spawnSupervisor(config: ProjectConfig): void {
  const logPath = serveLogFile(config)
  mkdirSync(path.dirname(logPath), { recursive: true })
  const log = openSync(logPath, 'a')
  try {
    // cwd stays config.dir so the child's run workspace defaults to the tree being worked
    spawn(process.execPath, [process.argv[1] ?? '', 'serve'], {
      cwd: config.dir, detached: true, stdio: ['ignore', log, log],
    }).unref()
  } finally {
    closeSync(log) // the child holds its own dup of the fd
  }
}

export function serveCommands(deps: Pick<ProgramDeps, 'actions' | 'needPlugin' | 'requireKernel' | 'plugin' | 'portFactory' | 'discovery'>): Command[] {
  const { actions, needPlugin, requireKernel, plugin, portFactory, discovery } = deps
  const group = new Command()
  group
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
        // copilot exchanges are events: the log is the record, the browser is a cache
        appendExchange: plugin ? async x => appendCopilotExchange(plugin.log, x, Door.web) : undefined,
      })
      console.log(`graph ui on http://127.0.0.1:${ui.port}`)
      await untilInterrupted()
      await ui.stop()
    })
  // one supervisor per project: the zone write-fence is an in-process Map
  const MAX_SUPERVISOR_SLOTS = 1
  const SERVE_NEEDS_STORAGE = 'serve needs a live storage connection'

  const serve = group.command('serve').description('run the project supervisor (holds the execution runtime)')
  serve
    .command('start', { isDefault: true })
    .description('start the supervisor in the foreground (auto-spawned in the background by other commands)')
    .option('--idle <minutes>', 'exit after this long with no live work', parsePositiveInteger, 30)
    .action(async (opts: { idle: number }) => {
      const { host, hub, config, storage } = needPlugin()
      if (!storage) throw new Error(SERVE_NEEDS_STORAGE)
      // claiming the slot IS the admission decision: a null claim means every slot is held
      const executorId = await claimSlot(storage, MAX_SUPERVISOR_SLOTS)
      if (!executorId) {
        console.error(`another supervisor is already live for '${config.projectName}' — see: orc serve status`)
        throw new CommandFailure(EXIT_CODE.failure)
      }
      // beat through buildRuntime: projection catch-up is unbounded and a silent boot reads as a hang
      console.log(`orc serve: ${executorId}  pid ${process.pid}  booting — projections catch up first ("ready" follows)`)
      const stopBootBeat = startBootHeartbeat(storage, executorId)
      let port: Awaited<ReturnType<typeof buildRuntime>>
      try {
        port = await buildRuntime({ host, hub, config, storage, executorId })
      } finally {
        stopBootBeat() // runSupervisor's own beat takes over from here
      }
      // for `serve status`/`serve stop` only: presence is decided by the heartbeat row alone
      atomicWriteFileSync(servePidFile(config.projectRoot), `${process.pid}\n`)
      console.log(`orc serve: ready  idle exit after ${opts.idle}m — ctrl-c to stop`)
      // `concurrency` is the cap per dependency depth, not per run: waves are awaited whole
      console.log(`  parallelism: ${config.concurrency} concurrent steps per depth (waves are awaited whole) · max depth ${config.maxDepth} · ${MAX_SUPERVISOR_SLOTS} supervisor`)
      console.log(`  ${knowledgeHealthLine(await knowledgeHealthOf({ config, log: storage.events }, requireKernel()))}`)
      try {
        await runSupervisor({ storage, port, idleMs: opts.idle * 60_000 })
      } finally {
        // draining would block shutdown on an hour-long parked gate; recovery owns resumption
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
      // a stale row is a supervisor that died holding work: name the slot instead of an empty list
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
  return [...group.commands]
}
