// Subprocess fixture: runs the real `run` command against a stub port so tests can
// assert the process exit status without poisoning the shared bun test process.
import type { ExecutionPort, RunHandle } from '@orc/contracts'
import { buildProgram, openKernel } from './main'

const [dbUrl, taskId, outcome] = process.argv.slice(2) as [string, string, 'done' | 'blocked']
const { kernel, log } = await openKernel(dbUrl)
const handle: RunHandle = { workflowId: 'fixture', wait: async () => outcome }
const port: ExecutionPort = {
  startRun: async () => handle,
  retry: async () => handle,
  cancelRun: async () => {},
}
await buildProgram(kernel, async () => port).parseAsync(['run', taskId], { from: 'user' })
await log.close()
