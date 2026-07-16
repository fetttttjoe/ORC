import { buildProgram, openKernel } from './main'

try {
  await buildProgram(openKernel()).parseAsync(process.argv)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
