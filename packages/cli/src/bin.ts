import { isConnectionRefused, loadConfig } from '@orc/kernel'
import { buildProgram, openKernel } from './main'
import { buildRuntime } from './runtime'

// The DBOS port is built lazily, once, only when a command actually asks for it —
// read-only commands never pay the DBOS launch, and new port commands need no registration here.
const runtime: { port: Awaited<ReturnType<typeof buildRuntime>> | null } = { port: null }

try {
  const kernel = await openKernel()
  await buildProgram(kernel, async () => (runtime.port ??= await buildRuntime())).parseAsync(process.argv)
  await runtime.port?.shutdown()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  if (isConnectionRefused(err)) {
    console.error(`Postgres is not reachable at ${loadConfig().databaseUrl} — start it with: docker compose up -d`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}
