import { Command } from 'commander'
import type { Analyzer, EventRecord, ExecutionPort, Plan } from '@orc/contracts'
import { openStorage, Kernel, liveSupervisors, requireProject, type EventLog, type OrcConfig, type ProjectConfig, type Storage } from '@orc/kernel'
import { buildModelDiscovery, buildOrcActions } from './actions'
import { adrCommand } from './adr-commands'
import { briefCommand } from './brief-commands'
import type { WorkspaceDoor } from './door-kernel'
import { DATABASE_UNREACHABLE } from './exit'
import { execCommands, statusCommand } from './exec-commands'
import { knowledgeCommand } from './knowledge-commands'
import { derivedPlanBlock } from './plan-render'
import { pluginCommands } from './plugin-commands'
import { databaseCommand, initCommand, projectCommands } from './project-commands'
import { CLI_ORIGIN, type ProgramDeps, type ProgramPlugin } from './program-deps'
import { reportOutcome, rootOf, watchRun } from './run-report'
import { serveCommands, spawnSupervisor } from './serve-commands'
import { ensureSupervisor, SUPERVISOR_MODE, type SupervisorMode } from './supervisor-client'
import { taskCommands } from './task-commands'
import { listWorkspaceHealth } from './workspace-health'
import { buildWorkspaceOps, type WorkspaceConfig } from './workspace-ops'
import { wsCommand, WS_NEEDS_PROJECT } from './ws-commands'

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

export function buildProgram(
  // null only on bin.ts's --help path, where no handler runs; the type says so honestly
  kernel: Kernel | null,
  portFactory?: () => Promise<ExecutionPort>,
  plugin?: ProgramPlugin,
  // set when the project database was unreachable at boot: anything needing a kernel fails with it
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

  // every handler touching the kernel goes through this: --help fails actionably, not a TypeError
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

  // after requireKernel: the deps object reads that binding at once (temporal dead zone)
  program.addCommand(wsCommand({ requireDoor: requireWsDoor }))
  program.addCommand(adrCommand({ requireKernel, noProject, ...(plugin && { project: { config: plugin.config, log: plugin.log } }) }))
  const knowledgeProject = plugin ? { config: plugin.config, log: plugin.log }
    : unreachable && { config: unreachable.config, logUnreachable: { reason: DATABASE_UNREACHABLE(unreachable.config.databaseUrl), error: unreachable.error } }
  program.addCommand(knowledgeCommand({ requireKernel, noProject, ...(knowledgeProject && { project: knowledgeProject }) }))
  program.addCommand(briefCommand({ noProject, ...(plugin && { project: { config: plugin.config, log: plugin.log } }) }))

  // declared up top so the `plan` command's rate line can reach it
  const discovery = plugin ? buildModelDiscovery(plugin.config, { log: plugin.log, origin: CLI_ORIGIN }) : undefined

  const requireTask: ProgramDeps['requireTask'] = async taskId => {
    const task = await requireKernel().getTask(taskId)
    if (!task) throw new Error(`no task '${taskId}'`)
    return task
  }

  const actions = () => buildOrcActions({ kernel: requireKernel(), ensureRuntime, plugin, listModels: discovery?.listModels, listModelOptions: discovery?.listModelOptions })

  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw noProject('execution commands are unavailable in this context')
    return portFactory()
  }

  // generous but bounded: a cold supervisor pays a DBOS launch and a plugin load before it beats
  const SPAWN_WAIT_MS = 15_000

  // commander maps --no-daemon to daemon:false; the env var serves callers that cannot pass flags
  const noDaemon = (): boolean => program.opts().daemon === false || process.env.ORC_NO_DAEMON === '1'

  // in-process means THIS command supervises, so the port is built here; no project, no spawn
  const ensureRuntime = async (): Promise<SupervisorMode> => {
    const storage = plugin?.storage
    const mode = await ensureSupervisor({
      live: storage ? () => liveSupervisors(storage, new Date()) : async () => [],
      spawn: () => spawnSupervisor(needPlugin().config),
      waitMs: SPAWN_WAIT_MS,
      noDaemon: noDaemon() || !storage,
      sleep: ms => Bun.sleep(ms),
      // lazy: only read once spawning happens, which --no-daemon never reaches
      config: () => needPlugin().config,
    })
    if (mode === SUPERVISOR_MODE.inProcess) await needPort()
    return mode
  }

  const derivedPlanFor = (taskId: string): Promise<string> =>
    derivedPlanBlock(requireKernel(), { autoCommit: plugin?.config.autoCommit, checks: plugin?.config.finishChecks ?? [] }, taskId)
  const report: ProgramDeps['report'] = (result, rootId) => reportOutcome({ requireKernel, derivedPlanFor }, result, rootId)
  const watchFrom: ProgramDeps['watchFrom'] = (taskId, since) => watchRun({ requireKernel, report }, taskId, since)

  const deps: ProgramDeps = {
    requireKernel, needPlugin, noProject, plugin, portFactory, discovery, actions, requireTask, derivedPlanFor,
    report, rootOf: taskId => rootOf({ requireKernel }, taskId), watchFrom,
  }
  const commands = [
    ...taskCommands(deps),
    ...projectCommands(deps),
    ...execCommands(deps),
    ...serveCommands(deps),
    statusCommand(deps),
    ...pluginCommands(deps),
  ]
  for (const command of commands) program.addCommand(command)

  return program
}
