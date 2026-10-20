import path from 'node:path'
import { Command } from 'commander'
import { AUTHOR_SOURCE, Door, NO_CHAT } from '@orc/contracts'
import { grantExtensionTrust, grantMcpTrust, isExtensionTrusted, isMcpTrusted, loadTrust } from '@orc/kernel'
import { createVaultProjector } from '@orc/vault-projector'
import { cwdAuthor } from './cwd-workspace'
import type { ProgramDeps } from './program-deps'
import { probeSupervisor } from './supervisor-probe'
import { listWorkspaceHealth } from './workspace-health'

export function pluginCommands(deps: Pick<ProgramDeps, 'actions' | 'needPlugin' | 'requireKernel' | 'portFactory'>): Command[] {
  const { actions, needPlugin, requireKernel, portFactory } = deps
  const group = new Command()
  group
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

  const vault = group.command('vault').description('OKF vault projection')
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

  const mcp = group.command('mcp').description('MCP servers orc uses as plugins + serving orc itself')
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
        // resolved before the server opens: a missing project context is a startup error, not a failed call
        author: await cwdAuthor(requireKernel(), config.dir, AUTHOR_SOURCE.agent, NO_CHAT(Door.mcp), { executor: MCP_SERVE_EXECUTOR }),
        // 'mcp': source 'cli' alone satisfies a grounded task's approve gate, so an agent cannot approve
        actions: portFactory ? actions() : null,
        autonomy: opts.autonomy,
        ...(storage && { supervisor: () => probeSupervisor(storage, config.projectRoot, config) }),
        // read-only, so wired whether or not this server can mutate
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

  const ext = group.command('ext').description('script extensions: declared in config, loaded only once trusted')
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
  return [...group.commands]
}
