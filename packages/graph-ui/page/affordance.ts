// What a view can offer for an OPEN agent question, and what it says once the answer lands.
// Withholding the CONTROL silently is how a parked run turns into a dead end: the question is right
// there, and nothing on screen says how to answer it. Every view that renders a LIVE question
// renders the box or the command, never nothing — and a question on an already-terminal task
// renders as a closed marker, since answering it could never resume anything.
//
// The gate is `canAnswer`, NOT the home-project fence: answering is a pure append the server makes
// in whichever project asked (page/api.ts, CROSS_PROJECT_ACTIONS), so only a server started outside
// any project — which can write nothing at all — falls back to the command. Fencing it to the home
// project meant the pane showed a question and refused to let the user answer it, sending them to a
// terminal for a row the server already had that project's log to write.
//
// It is also the one place the reply command is spelled. Three views need it; three copies would
// drift the first time the CLI's flags change.
import { STEP_ID, TERMINAL_TASK_STATUS } from '@orc/contracts'
import type { TaskStatus } from '@orc/contracts'
import type { OrcActions } from '@orc/ui-core' // type-only: never pulls the server into the bundle
import type { Tone } from './ui/components'

export const REPLY_AFFORDANCE = { box: 'box', command: 'command', closed: 'closed' } as const
export type ReplyAffordanceKind = (typeof REPLY_AFFORDANCE)[keyof typeof REPLY_AFFORDANCE]

export type ReplyAffordance =
  | { kind: typeof REPLY_AFFORDANCE.box }
  | { kind: typeof REPLY_AFFORDANCE.command; cmd: string }
  | { kind: typeof REPLY_AFFORDANCE.closed; status: string }

// A question on a TERMINAL task (done/failed/cancelled) is inert history: answering it can never
// resume anything, so neither the box nor the CLI command is honest — both promise a resumption
// that will not happen. When a status is known and terminal, close the question BEFORE the
// canAnswer branch, so terminal status wins regardless of whether this UI could otherwise answer.
// `status` omitted (or non-terminal) keeps the old box/command choice exactly — the two existing
// 2-arg call sites (app.ts Chat inspector, plan.ts yourMove) are untouched by this.
export function replyAffordance(canAnswer: boolean, taskId: string, status?: string): ReplyAffordance {
  if (status !== undefined && TERMINAL_TASK_STATUS.has(status as TaskStatus)) return { kind: REPLY_AFFORDANCE.closed, status }
  return canAnswer
    ? { kind: REPLY_AFFORDANCE.box }
    : { kind: REPLY_AFFORDANCE.command, cmd: `orc reply ${taskId} "<your answer>"` }
}

// The result the reply action hands back — derived from the contract the server implements, so the
// page cannot drift from it.
export type ReplyResult = Awaited<ReturnType<OrcActions['reply']>>

// What the user is told once the answer is in. A foreign project's question can be answered from
// here, and that project may have nothing running behind it: the append is durable and the next
// supervisor picks it up off feedback_provided, but a bare "step resuming" would claim a resumption
// that is not happening. The three outcomes read differently because they ARE different.
export function replyReceipt(r: ReplyResult): { text: string; tone: Tone } {
  if (!r.answered) return { text: 'no open question left to answer — it was answered elsewhere', tone: 'warn' }
  return r.supervised
    ? { text: 'replied — step resuming', tone: 'ok' }
    : { text: 'answer saved — no supervisor is running that project, so it stays queued until one starts', tone: 'warn' }
}

// The word the button sends lives in @orc/contracts (APPROVAL_ANSWER, approval-answer.ts) with the
// predicate the kernel gate matches on. It used to be spelled here as well as twice in kernel.ts —
// two independent copies of one protocol constant, on opposite sides of a process boundary, pinned
// only by a test. Change the kernel's half of a pair like that and the button silently does nothing.
//
// Which open question earns the one-click approve. Only the grounded plan step's question, because
// that is the only one where the kernel reads the answer as more than plain text (it freezes the
// plan graph the human just saw). Offering it on every question would ship "approve" as an answer
// to "which model should this run on?".
//
// The pane learns this from the feedback_requested row's stepId — the same field the kernel keys
// the gate on. Whether the TASK is grounded is not on the row; it does not need to be, because on
// a non-grounded task the click is an ordinary text reply and costs nothing.
export const isApprovalGate = (stepId: string | null): boolean => stepId === STEP_ID.plan
