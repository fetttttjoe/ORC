// Subprocess fixture: runs the real `run` command against a stub port so tests can
// assert the process exit status without poisoning the shared bun test process.
import type { ExecutionPort, RunHandle } from '@orc/contracts'
import { buildProgram, openKernel } from './main'
import { TEST_PROJECT_ID } from '@orc/kernel/test-helpers'

const [dbUrl, taskId, outcome] = process.argv.slice(2)
if (!dbUrl || !taskId || (outcome !== 'done' && outcome !== 'blocked'))
  throw new Error('usage: exec-fixture <dbUrl> <taskId> done|blocked')
const { kernel, log } = await openKernel(dbUrl, { projectId: TEST_PROJECT_ID })
const handle: RunHandle = { workflowId: 'fixture', wait: async () => outcome }
const port: ExecutionPort = {
  startRun: async () => handle,
  retry: async () => handle,
  cancelRun: async () => {},
}
await buildProgram(kernel, async () => port).parseAsync(['run', taskId], { from: 'user' })
await log.close()
