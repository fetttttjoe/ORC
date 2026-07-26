// What a view can offer for an OPEN agent question. The project fence (`canAct`) withholds writes
// for any project this server was not started in — but withholding the CONTROL silently is how a
// parked run turns into a dead end: the question is right there, and nothing on screen says how to
// answer it. Every view that renders a question renders one of these two, never nothing.
//
// It is also the one place the reply command is spelled. Three views need it; three copies would
// drift the first time the CLI's flags change.
export const REPLY_AFFORDANCE = { box: 'box', command: 'command' } as const
export type ReplyAffordanceKind = (typeof REPLY_AFFORDANCE)[keyof typeof REPLY_AFFORDANCE]

export type ReplyAffordance =
  | { kind: typeof REPLY_AFFORDANCE.box }
  | { kind: typeof REPLY_AFFORDANCE.command; cmd: string }

export function replyAffordance(canAct: boolean, taskId: string): ReplyAffordance {
  return canAct
    ? { kind: REPLY_AFFORDANCE.box }
    : { kind: REPLY_AFFORDANCE.command, cmd: `orc reply ${taskId} "<your answer>"` }
}
