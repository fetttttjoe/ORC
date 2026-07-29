import { z } from 'zod'

// The vocabulary of the CONVERSATIONAL plan gate: which typed answers to a grounded task's
// `plan` step question count as a human saying "go ahead" (Kernel.replyFeedback stamps planHash,
// Kernel.approvedPlanHash reads it back, finalize_plan requires it).
//
// NOT the same approval as `approvePlan`/`orc approve <taskId>`/the UI's "approve plan" button,
// which sets a task's approvedVersion and emits plan_approved; and NOT the same as ApprovalPolicy
// in approval.ts, which decides whether a proposed CHILD task needs a human at all. Three gates,
// three concepts — do not merge them.
//
// Two failures motivate this file:
//   1. The word was spelled independently on both sides of a process boundary — a bare 'approve'
//      literal twice in kernel.ts, and a second copy in the browser bundle's affordance.ts. The
//      same shape as the hash mismatch that made this gate unsatisfiable for eight consecutive
//      approvals: two processes disagreeing about one value, failing silently. Changing the
//      kernel's match would have left the UI's approve button doing nothing visible.
//   2. A human answered "agree" and the gate ignored it. The answer became ordinary feedback, the
//      plan never froze, and the agent re-asked. One of those eight failures was exactly that.
//
// Every word here must, STANDING ALONE AS A COMPLETE ANSWER, be capable of no reading other than
// assent to proceed. Deliberately absent: a bare 'y'. It saves two keystrokes over 'yes' and the
// one-click button makes even those unnecessary, but a stray keystroke sent by accident would
// approve a run — finalize_plan force-auto-approves the split it derives, so a false accept here
// executes a plan nobody read.
export const APPROVAL_ANSWERS = [
  'approve', 'approved', 'agree', 'agreed', 'yes', 'ok', 'okay', 'lgtm', 'go', 'proceed',
] as const
export const ApprovalAnswer = z.enum(APPROVAL_ANSWERS)
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>

// The canonical word — what the UI's one-click approve button sends, and what docs and tool
// descriptions tell a human to type. Anything else in the set is a courtesy to a human who typed
// what came naturally.
export const APPROVAL_ANSWER = ApprovalAnswer.enum.approve

// WHOLE-STRING match after trim + case-fold — exactly what the two kernel literals did, so every
// answer already stored in the event log resolves the same way. Never a substring: "do not
// approve" and "approve?" are not approvals, and a contains-check would read the first as the
// opposite of what it says.
export const isApprovalAnswer = (text: string): boolean =>
  ApprovalAnswer.safeParse(text.trim().toLowerCase()).success
