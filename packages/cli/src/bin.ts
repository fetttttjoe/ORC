import { isConnectionRefused, loadConfig } from '@orc/kernel'
import { HOOK_NAME } from '@orc/contracts'
import { buildProgram, openKernel } from './main'
import { buildPlugins, buildRuntime } from './runtime'

// The DBOS port is built lazily, once, only when a command actually asks for it —
// read-only commands never pay the DBOS launch, and new port commands need no registration here.
const runtime: { port: Awaited<ReturnType<typeof buildRuntime>> | null } = { port: null }

try {
  const config = loadConfig()
  const plugins = await buildPlugins(config)
  await plugins.host.hooks.emit(HOOK_NAME.session_start)
  const { kernel, log } = await openKernel(config.databaseUrl, {
    refValidator: plugins.host.refValidator,
    onAppend: e => void plugins.host.hooks.emit(HOOK_NAME.event_appended, e),
  })
  await buildProgram(
    kernel,
    async () => (runtime.port ??= await buildRuntime({ ...plugins, config, log, kernel })),
    { host: plugins.host, hub: plugins.hub, config, log },
  ).parseAsync(process.argv)
  if (runtime.port) await runtime.port.shutdown()
  else { await plugins.hub.close(); await plugins.host.shutdown() }
  process.exit(process.exitCode ?? 0)
} catch (err) {
  if (isConnectionRefused(err)) {
    console.error(`Postgres is not reachable at ${loadConfig().databaseUrl} — start it with: docker compose up -d`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}
