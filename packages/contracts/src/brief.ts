import { z } from 'zod'
import { KnowledgeHealth } from './health'
import { TASK_STATUS } from './task'
import { WorkspaceWithHealth } from './workspace-entity'

// What a session is told about a project before it has asked anything: the shape `orc brief --json`
// prints and the text form renders from. A schema rather than an interface because it crosses a
// process boundary — a script or another door reads it back.

// The statuses that ask something of whoever is reading: a plan to approve, work in flight, a step
// parked on a question or a failure. The tuple is also the ORDER the brief lists them in — what
// needs a human comes before what is merely moving. `draft` and `approved` are deliberately out:
// neither is waiting on anyone but the operator's own next command.
export const BRIEF_TASK_STATUSES = [TASK_STATUS.awaiting_approval, TASK_STATUS.running, TASK_STATUS.blocked] as const
export type BriefTaskStatus = (typeof BRIEF_TASK_STATUSES)[number]

// Ceilings on a block that is injected into EVERY session's context, where each line is paid for on
// every turn after it. Unmeasured: 5 decisions of at most 160 characters plus 3 × 5 task lines keeps
// the whole brief under roughly 2 KB, and nothing yet says that is the right trade. What would
// settle it is reading real transcripts for decisions a session needed and was not shown.
//
// `decisions` cuts by recency because that is the listing's order. The upgrade is relevance — rank
// by overlap between a decision's declared paths and the files this workspace has changed — and it
// belongs in the pure builder, not here.
export const BRIEF_LIMITS = { decisions: 5, tasksPerStatus: 5, decisionLineChars: 160 } as const

export const BriefTask = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(BRIEF_TASK_STATUSES),
  workspaceId: z.string().min(1),
  // null when the task names a workspace the fold never saw — a log defect `orc tasks` reports
  // loudly; here the task is still worth showing, just without a label.
  workspaceTitle: z.string().nullable(),
})
export type BriefTask = z.infer<typeof BriefTask>

export const BriefDecision = z.object({ id: z.string().min(1), title: z.string(), summary: z.string() })
export type BriefDecision = z.infer<typeof BriefDecision>

export const Brief = z.object({
  project: z.string().min(1),
  // null = this directory is not a recorded workspace. Boot adoption records every checkout before
  // a command runs, so in practice this is a fold that has not caught up with the log yet.
  workspace: WorkspaceWithHealth.nullable(),
  // Other workspaces in the two states that carry an action (dangling → merge or archive, waiting →
  // approve or reply). Counts, not rows: the brief points at `orc ws ls`, it does not replace it.
  elsewhere: z.object({ dangling: z.number().int(), waiting: z.number().int() }),
  tasks: z.array(BriefTask),
  // What the cap dropped, PER STATUS — the cap is per status, so the admission has to be too. One
  // total printed after the last group read as that group's own remainder: seven running and one
  // blocked came out as "blocked: 1 shown, +2 more". A capped list that does not admit it was
  // capped reads as the whole truth; one that admits it under the wrong heading is worse.
  hiddenTasks: z.record(z.enum(BRIEF_TASK_STATUSES), z.number().int()),
  // null = the decision files could not be read. NOT an empty list: "this project has decided
  // nothing" and "the files could not be read" must not render the same, or an outage silently licenses
  // re-opening every settled question.
  decisions: z.object({ shown: z.array(BriefDecision), total: z.number().int() }).nullable(),
  knowledge: KnowledgeHealth,
})
export type Brief = z.infer<typeof Brief>
