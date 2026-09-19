#!/usr/bin/env bun
import { isConnectionRefused, loadConfig, ProjectNotInitializedError, requireProject } from '@orc/kernel'
import { Door, errorMessage, HOOK_NAME, NO_CHAT } from '@orc/contracts'
import { buildProgram, openKernel, runInit, runMigrate } from './main'
import { EXIT_CODE, exitCodeFor } from './exit'
import type { Command } from 'commander'
import { bootPhase, buildPlugins, buildRuntime } from './runtime'
import { adoptCwd } from './workspace-adopt'

// The DBOS port is built lazily, once, only when a command actually asks for it —
// read-only commands never pay the DBOS launch, and new port commands need no registration here.
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
      return parse(buildProgram(null), process.argv)

    const config = requireProject(loadConfig())
    const loaded = await buildPlugins(config)
    plugins = loaded
    await loaded.host.hooks.emit(HOOK_NAME.session_start)
    // Timed with the SAME instrument buildRuntime uses for its own phases: this open (via
    // openKernel) happens before buildRuntime ever runs and threads its storage in already, so
    // buildRuntime's own bootPhase('storage', ...) call is always skipped on this path — without
    // this, the storage open (part of the boot window) never appears in the printed boot line.
    const openTiming: Array<[string, number]> = []
    const opened = await bootPhase('storage', () => openKernel(config.databaseUrl, {
      projectId: config.projectId,
      redactEnv: config.redactEnv,
      refValidator: loaded.host.refValidator,
      analyzers: loaded.host.analyzers,
      // No `send`: DBOS.send needs DBOS launched in THIS process, and a client command has no
      // runtime. The supervisor's router already delivers every feedback_provided under the same
      // idempotency key (the event's own seq), so this was a duplicate of the delivery that works
      // in both modes — and the only one that could throw where there is nothing to send with.
      onAppend: e => loaded.host.hooks.dispatch(HOOK_NAME.event_appended, e),
    }), openTiming)
    storage = opened.storage
    // Adoption runs at EVERY boot, here and nowhere else: this is the one place a kernel is
    // guaranteed open (the --help path above returns with none), and every door — including
    // `orc mcp serve`, a subcommand of the program parsed below — boots through it. A second call
    // inside mcp-serve.ts would be a second spelling of the same rule, not a second behaviour.
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
  // The code is set here and the message still printed below: a terminal user needs the sentence,
  // a caller that runs orc in every repository needs only the number.
  if (error instanceof ProjectNotInitializedError) exitCode = EXIT_CODE.noProject
  if (isConnectionRefused(error))
    console.error(`Postgres is not reachable at ${loadConfig().databaseUrl} — start it with: docker compose up -d`)
  // errorMessage prettifies a ZodError (path + message, never the raw issue-JSON dump) — the
  // same rendering every tool-result boundary uses, so a validation failure reads identically
  // here and in a transcript
  else console.error(errorMessage(error))
}
process.exit(exitCode)
