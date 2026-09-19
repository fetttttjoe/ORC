// Subprocess fixture: runs the real `run` command against a stub port so tests can
// assert the process exit status without poisoning the shared bun test process.
import { Door, EVENT_KIND, NO_CHAT, TASK_STATUS, type ExecutionPort, type RunHandle, type TaskStatus } from '@orc/contracts'
import { buildProgram, openKernel } from './main'
import { exitCodeFor } from './exit'
import { TEST_PROJECT_ID } from '@orc/kernel/test-helpers'

const [dbUrl, taskId, outcome] = process.argv.slice(2)
if (!dbUrl || !taskId || (outcome !== TASK_STATUS.done && outcome !== TASK_STATUS.blocked))
  throw new Error('usage: exec-fixture <dbUrl> <taskId> done|blocked')
const { kernel, log } = await openKernel(dbUrl, { projectId: TEST_PROJECT_ID })
const handle: RunHandle = { workflowId: 'fixture', wait: async () => outcome }
const port: ExecutionPort = {
  startRun: async () => handle,
  retry: async () => handle,
  cancelRun: async () => {},
}
// The supervisor's half, faked: this fixture holds no runtime, so once the command has recorded
// its ask, the statuses a real run would stamp are appended here. Without them the watch would
// wait forever on a task nothing is driving — which is the point of a supervisor, not a bug.
const stamp = (from: TaskStatus, to: TaskStatus) => log.append({
  // Door.supervisor: these are the appends the supervisor's half would make, and this fixture is
  // standing in for it.
  ...NO_CHAT(Door.supervisor), taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from, to },
})
const driving = (async () => {
  for (let i = 0; i < 500; i++) {
    if ((await log.byTask(taskId)).some(e => e.kind === EVENT_KIND.run_requested)) break
    await Bun.sleep(20)
  }
  await stamp(TASK_STATUS.approved, TASK_STATUS.running)
  await stamp(TASK_STATUS.running, outcome)
})()
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
await driving
await log.close()
process.exit(code)
