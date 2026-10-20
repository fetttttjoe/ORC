// subprocess fixture: runs the real `run` command so tests can assert the exit status
import { Door, EVENT_KIND, NO_CHAT, RunOutcome, TASK_STATUS, type ExecutionPort, type RunHandle, type TaskStatus } from '@orc/contracts'
import { buildProgram, openKernel } from './main'
import { exitCodeFor } from './exit'
import { TEST_PROJECT_ID, testOrcConfig } from '@orc/kernel/test-helpers'

const [dbUrl, taskId, outcome] = process.argv.slice(2)
if (!dbUrl || !taskId || (outcome !== 'done' && outcome !== 'blocked'))
  throw new Error('usage: exec-fixture <dbUrl> <taskId> done|blocked')
const runOutcome = outcome === 'done' ? RunOutcome.done : RunOutcome.blocked
const taskStatus = outcome === 'done' ? TASK_STATUS.done : TASK_STATUS.blocked
const { kernel, log } = await openKernel(dbUrl, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
const handle: RunHandle = { workflowId: 'fixture', wait: async () => runOutcome }
const port: ExecutionPort = {
  startRun: async () => handle,
  retry: async () => handle,
  cancelRun: async () => {},
}
// the supervisor's half, faked: without these appends the watch waits on a task nothing drives
const stamp = (from: TaskStatus, to: TaskStatus) => log.append({
  ...NO_CHAT(Door.supervisor), taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from, to },
})
const driving = (async () => {
  for (let i = 0; i < 500; i++) {
    if ((await log.byTask(taskId)).some(e => e.kind === EVENT_KIND.run_requested)) break
    await Bun.sleep(20)
  }
  await stamp(TASK_STATUS.approved, TASK_STATUS.running)
  await stamp(TASK_STATUS.running, taskStatus)
})()
// mirrors bin.ts: a command states its outcome by throwing, the entry point maps it to the exit
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
