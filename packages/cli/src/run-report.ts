import { RunOutcome } from '@orc/contracts'
import { subtreeUsage } from '@orc/kernel'
import { CommandFailure, EXIT_CODE } from './exit'
import type { ProgramDeps } from './program-deps'
import { formatUsageLine } from './usage-render'
import { watchSubtree, type TailResult } from './watch'

// rootId is the ROOT of the watched tree: a child's id would undercount subtreeUsage
export async function reportOutcome(deps: Pick<ProgramDeps, 'requireKernel' | 'derivedPlanFor'>, result: TailResult, rootId: string): Promise<void> {
  const { requireKernel, derivedPlanFor } = deps
  // a parked run is not a failure: exit 0 and name the command that unparks it
  if (result.parked) {
    // the id names the task that ASKED, which after a split is the child, not the watched task
    console.log(`run parked on a question: ${result.question}`)
    // the human approves THIS, not the prose above it
    const derived = await derivedPlanFor(result.taskId)
    if (derived) console.log(derived)
    console.log(`answer it to continue: orc reply ${result.taskId} <text>`)
    return
  }
  // subtreeUsage, not taskUsage: a run's cost is the whole tree's, split children included
  const state = await requireKernel().state()
  console.log(formatUsageLine(subtreeUsage(state, rootId)))
  console.log(`run finished: ${result.outcome}`)
  if (result.outcome !== RunOutcome.done) throw new CommandFailure(EXIT_CODE.failure)
}

// a split child only resolves a gate held by an ancestor, so the root is the run to watch
export async function rootOf(deps: Pick<ProgramDeps, 'requireKernel'>, taskId: string): Promise<string> {
  const { requireKernel } = deps
  const state = await requireKernel().state()
  let id = taskId
  for (let parent = state.tasks.get(id)?.parentId; parent; parent = state.tasks.get(id)?.parentId) id = parent
  return id
}

// the command starts nothing: a supervisor turns the recorded ask into a workflow
export async function watchRun(deps: Pick<ProgramDeps, 'requireKernel' | 'report'>, taskId: string, since: number | undefined): Promise<void> {
  const { requireKernel, report } = deps
  console.log(`run requested for ${taskId} — watching (ctrl-c stops watching, not the run: orc cancel ${taskId} stops it)`)
  const root = await rootOf(deps, taskId)
  await report(await watchSubtree(requireKernel(), taskId, since), root)
}
