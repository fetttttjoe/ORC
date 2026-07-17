import { buildProgram, isConnectionRefused, openKernel, DEFAULT_DATABASE_URL } from './main'

try {
  const kernel = await openKernel()
  await buildProgram(kernel).parseAsync(process.argv)
  process.exit(0)
} catch (err) {
  if (isConnectionRefused(err)) {
    const url = process.env.ORC_DATABASE_URL ?? DEFAULT_DATABASE_URL
    console.error(`Postgres is not reachable at ${url} — start it with: docker compose up -d`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}
