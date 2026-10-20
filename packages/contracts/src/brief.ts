import { z } from 'zod'
import { KnowledgeHealth } from './health'
import { TASK_STATUS } from './task'
import { WorkspaceWithHealth } from './workspace-entity'


// ordered by what needs a human first; draft and approved wait on no one but the operator
export const BRIEF_TASK_STATUSES = [TASK_STATUS.awaiting_approval, TASK_STATUS.running, TASK_STATUS.blocked] as const
export type BriefTaskStatus = (typeof BRIEF_TASK_STATUSES)[number]

// unmeasured ceilings on a block paid for every turn: ~2 KB at 5 decisions and 3x5 task lines
export const BRIEF_LIMITS = { decisions: 5, tasksPerStatus: 5, decisionLineChars: 160 } as const

export const BriefTask = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(BRIEF_TASK_STATUSES),
  workspaceId: z.string().min(1),
  // null when the task names a workspace the fold never saw
  workspaceTitle: z.string().nullable(),
})
export type BriefTask = z.infer<typeof BriefTask>

export const BriefDecision = z.object({ id: z.string().min(1), title: z.string(), summary: z.string() })
export type BriefDecision = z.infer<typeof BriefDecision>

export const Brief = z.object({
  project: z.string().min(1),
  // null = this directory is not a recorded workspace
  workspace: WorkspaceWithHealth.nullable(),
  // counts, not rows: the brief points at orc ws ls, it does not replace it
  elsewhere: z.object({ dangling: z.number().int(), waiting: z.number().int() }),
  tasks: z.array(BriefTask),
  // per status, because one total printed after the last group read as that group's remainder
  hiddenTasks: z.record(z.enum(BRIEF_TASK_STATUSES), z.number().int()),
  // null = unreadable, not empty: the two must not render alike
  decisions: z.object({ shown: z.array(BriefDecision), total: z.number().int() }).nullable(),
  knowledge: KnowledgeHealth,
})
export type Brief = z.infer<typeof Brief>
