#!/usr/bin/env bun
import { isConnectionRefused, loadConfig, ProjectNotInitializedError, requireProject } from '@orc/kernel'
import { Door, errorMessage, HookName, NO_CHAT } from '@orc/contracts'
import { buildProgram, openKernel } from './main'
import { runInit, runMigrate } from './project-commands'
import { DATABASE_UNREACHABLE, EXIT_CODE, exitCodeFor } from './exit'
import type { Command } from 'commander'
import { bootPhase, buildPlugins, buildRuntime } from './runtime'
import { adoptCwd } from './workspace-adopt'

// built lazily: read-only commands never pay the DBOS launch
const runtime: { port: Awaited<ReturnType<typeof buildRuntime>> | null } = { port: null }

function overrideExits(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) overrideExits(child)
}

async function parse(program: Command, argv: string[]): Promise<number> {
  overrideExits(program)
  try {
    await program.parseAsync(argv)
    return 0
  } catch (error) {
    // a command that finished unsuccessfully has already printed why — carry only its code
    const failure = exitCodeFor(error)
    if (failure !== null) return failure
    if (error && typeof error === 'object' && 'code' in error && 'exitCode' in error
      && String(error.code).startsWith('commander.') && typeof error.exitCode === 'number')
      return error.exitCode
    throw error
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  // under mcp serve stdout carries only MCP frames: rebind console channels to stderr before boot
  if (args[0] === 'mcp' && args[1] === 'serve')
    for (const k of ['log', 'info', 'debug'] as const) console[k] = console.error.bind(console)
  let plugins: Awaited<ReturnType<typeof buildPlugins>> | null = null
  let storage: Awaited<ReturnType<typeof openKernel>>['storage'] | null = null
  try {
    // init/help/migrate run before Postgres/plugins/identity exist
    if (args[0] === 'init') { await runInit(args.slice(1)); return 0 }
    if (args[0] === 'db' && args[1] === 'migrate') { await runMigrate(args.slice(1)); return 0 }
    if (args.includes('--help') || args.includes('-h') || args[0] === 'help')
      return parse(buildProgram(null), process.argv)

    const config = requireProject(loadConfig())
    const loaded = await buildPlugins(config)
    plugins = loaded
    await loaded.host.hooks.emit(HookName.session_start)
    // timed like buildRuntime's phases: this open runs first, so its storage phase would never print
    const openTiming: Array<[string, number]> = []
    const booted = await bootPhase('storage', () => openKernel(config.databaseUrl, {
      config,
      projectId: config.projectId,
      redactEnv: config.redactEnv,
      refValidator: loaded.host.refValidator,
      analyzers: loaded.host.analyzers,
      // no `send`: DBOS.send needs a launched runtime and the supervisor's router already delivers
      onAppend: e => loaded.host.hooks.dispatch(HookName.event_appended, e),
    }).then(opened => ({ opened }), (error: unknown) => {
      if (!isConnectionRefused(error)) throw error
      return { unreachable: error }
    }), openTiming)
    if ('unreachable' in booted) return parse(buildProgram(null, undefined, undefined, { config, error: booted.unreachable }), process.argv)
    const { opened } = booted
    storage = opened.storage
    // adoption runs at every boot, here only: the one place a kernel is guaranteed open
    await adoptCwd(opened.kernel, config, NO_CHAT(Door.cli))
    const storageMs = openTiming[0]?.[1]
    return await parse(buildProgram(
      opened.kernel,
      async () => (runtime.port ??= await buildRuntime({ ...loaded, config, storage: opened.storage, storageMs, kernel: opened.kernel })),
      { host: loaded.host, hub: loaded.hub, config, log: opened.log, storage: opened.storage },
    ), process.argv)
  } finally {
    try {
      // this process exits on the next line; a parked gate is resumed by recovery, not by waiting
      if (runtime.port) await runtime.port.shutdown({ drain: false })
      else if (plugins) {
        try { await plugins.host.shutdown() }
        finally { await plugins.hub.close() }
      }
    } finally {
      await storage?.close()
    }
  }
}

let exitCode: number = EXIT_CODE.failure
try {
  exitCode = await main()
} catch (error) {
  // the code is set here and the message still printed: a terminal reader needs the sentence
  if (error instanceof ProjectNotInitializedError) exitCode = EXIT_CODE.noProject
  if (isConnectionRefused(error))
    console.error(DATABASE_UNREACHABLE(loadConfig().databaseUrl))
  else console.error(errorMessage(error))
}
process.exit(exitCode)
