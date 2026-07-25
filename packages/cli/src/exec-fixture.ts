// Subprocess fixture: runs the real `run` command against a stub port so tests can
// assert the process exit status without poisoning the shared bun test process.
import type { ExecutionPort, RunHandle } from '@orc/contracts'
import { buildProgram, openKernel } from './main'
import { exitCodeFor } from './exit'
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
// mirrors bin.ts: a command states its outcome by throwing, the entry point turns it into the
// process's exit status. This fixture exists to observe that status, so it must translate it the
// same way the real binary does.
let code = 0
try {
  await buildProgram(kernel, async () => port).parseAsync(['run', taskId], { from: 'user' })
} catch (error) {
  const failure = exitCodeFor(error)
  if (failure === null) throw error
  code = failure
}
await log.close()
process.exit(code)
