import { TASK_STATUS } from '@orc/contracts/task'
import type { Temperature } from '$lib/temperature'

/**
 * The ONE next thing a human can do about a task, decided as data. Pure and exhaustive over the
 * lifecycle, so the affordance a pane renders can be unit-tested without a DOM: the pane picks a
 * control per `kind`, never re-derives the decision.
 *
 * Ordering is the point — a failed step outranks an open question outranks the status, because
 * that is the order an operator must deal with them.
 */
export type MoveKind = 'retry' | 'answer' | 'propose' | 'approve' | 'run' | 'watch' | 'none'

export interface Move {
  kind: MoveKind
  /** what is true right now, in the operator's words */
  text: string
  temp: Temperature
  /** the equivalent CLI, shown when this server cannot perform the action */
  cmd: string | null
}

export interface MoveInput {
  taskId: string
  status: string
  failedStepId: string | null
  openQuestion: string | null
  artifactCount: number
}

export function yourMove(t: MoveInput): Move {
  if (t.failedStepId)
    return {
      kind: 'retry',
      text: `step '${t.failedStepId}' failed — read its chat, then retry`,
      temp: 'rust',
      cmd: `orc retry ${t.taskId}`,
    }

  if (t.openQuestion)
    return { kind: 'answer', text: `the agent is asking: “${t.openQuestion}”`, temp: 'human', cmd: `orc reply ${t.taskId} "your answer"` }

  switch (t.status) {
    case TASK_STATUS.draft:
      return { kind: 'propose', text: 'no plan yet — propose one', temp: 'machine', cmd: `orc propose ${t.taskId} --model <ref>` }
    // The STRUCTURAL approval: kernel.approvePlan stamps approvedVersion for a task that already
    // HAS a proposed version. Distinct from a gate's APPROVAL_ANSWER, which stamps a plan hash on
    // a grounded task where no plan version exists yet — routing one through the other does nothing.
    case TASK_STATUS.awaiting_approval:
      return { kind: 'approve', text: 'a plan is waiting for your approval — review the steps below', temp: 'human', cmd: `orc approve ${t.taskId}` }
    case TASK_STATUS.approved:
      return { kind: 'run', text: 'approved and ready — start the run', temp: 'machine', cmd: `orc run ${t.taskId} --cwd .` }
    case TASK_STATUS.running:
      return { kind: 'watch', text: 'agents are working — the ledger and chat show progress', temp: 'machine', cmd: null }
    case TASK_STATUS.blocked:
      return { kind: 'watch', text: 'blocked — the newest chat messages carry the reason', temp: 'rust', cmd: null }
    case TASK_STATUS.done:
      return { kind: 'none', text: `done — ${t.artifactCount} verified artifact(s)`, temp: 'moss', cmd: null }
    case TASK_STATUS.cancelled:
      return { kind: 'none', text: 'cancelled', temp: 'neutral', cmd: null }
    default:
      return { kind: 'none', text: t.status, temp: 'neutral', cmd: null }
  }
}
