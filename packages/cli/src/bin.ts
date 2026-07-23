#!/usr/bin/env bun
import { dbosSend, isConnectionRefused, loadConfig, requireProject, type Kernel } from '@orc/kernel'
import { errorMessage, HOOK_NAME } from '@orc/contracts'
import { buildProgram, openKernel, runInit, runMigrate } from './main'
import type { Command } from 'commander'
import { buildPlugins, buildRuntime } from './runtime'

// The DBOS port is built lazily, once, only when a command actually asks for it —
// read-only commands never pay the DBOS launch, and new port commands need no registration here.
const runtime: { port: Awaited<ReturnType<typeof buildRuntime>> | null } = { port: null }

function formatCliError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues))
    return error.issues.map(issue => {
      if (!issue || typeof issue !== 'object') return String(issue)
      const value = issue as { path?: unknown[]; message?: unknown }
      const path = value.path?.map(String).join('.') || 'input'
      return `${path}: ${String(value.message ?? 'invalid value')}`
    }).join('\n')
  return errorMessage(error)
}

function overrideExits(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) overrideExits(child)
}

async function parse(program: Command, argv: string[]): Promise<number> {
  overrideExits(program)
  try {
    await program.parseAsync(argv)
    return Number(process.exitCode ?? 0)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && 'exitCode' in error
      && String(error.code).startsWith('commander.') && typeof error.exitCode === 'number')
      return error.exitCode
    throw error
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  // P7 door #2: under `mcp serve`, stdout carries ONLY MCP protocol frames — rebind every
  // stdout-bound console channel to stderr BEFORE any boot code (plugins, storage, memory)
  // can print. warn/error already target stderr; DBOS never boots on the read path (lazy port).
  if (args[0] === 'mcp' && args[1] === 'serve')
    for (const k of ['log', 'info', 'debug'] as const) console[k] = console.error.bind(console)
  let plugins: Awaited<ReturnType<typeof buildPlugins>> | null = null
  let storage: Awaited<ReturnType<typeof openKernel>>['storage'] | null = null
  try {
    // init/help/migrate run before Postgres/plugins/identity exist
    if (args[0] === 'init') { await runInit(args.slice(1)); return 0 }
    if (args[0] === 'db' && args[1] === 'migrate') { await runMigrate(args.slice(1)); return 0 }
    if (args.includes('--help') || args.includes('-h') || args[0] === 'help')
      return parse(buildProgram({} as Kernel), process.argv)

    const config = requireProject(loadConfig())
    plugins = await buildPlugins(config)
    await plugins.host.hooks.emit(HOOK_NAME.session_start)
    const opened = await openKernel(config.databaseUrl, {
      projectId: config.projectId,
      redactEnv: config.redactEnv,
      refValidator: plugins.host.refValidator,
      analyzers: plugins.host.analyzers,
      send: dbosSend,
      onAppend: e => plugins!.host.hooks.dispatch(HOOK_NAME.event_appended, e),
    })
    storage = opened.storage
    return await parse(buildProgram(
      opened.kernel,
      async () => (runtime.port ??= await buildRuntime({ ...plugins!, config, storage: opened.storage, kernel: opened.kernel })),
      { host: plugins.host, hub: plugins.hub, config, log: opened.log, storage: opened.storage },
    ), process.argv)
  } finally {
    try {
      if (runtime.port) await runtime.port.shutdown()
      else if (plugins) {
        try { await plugins.host.shutdown() }
        finally { await plugins.hub.close() }
      }
    } finally {
      await storage?.close()
    }
  }
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  if (isConnectionRefused(error))
    console.error(`Postgres is not reachable at ${loadConfig().databaseUrl} — start it with: docker compose up -d`)
  else console.error(formatCliError(error))
}
process.exit(exitCode)
