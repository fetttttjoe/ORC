import { api } from './client'
import * as S from './schemas'

// Every mutation the UI performs, in one typed seam; result schemas are parsed, not asserted

/** what `reply` reports back — the three outcomes read differently because they ARE different */
export type ReplyResult = { answered: boolean; supervised: boolean }

/** what a purge or delete removed, plus anything it could not */
export type PurgeReport = { events?: number; operations?: number; warnings: string[] }

export interface GroundedSpec {
  modelRef: string
  cwd: string
  analyzerRef?: string
}

export const actions = {
  // budgetUSD is stated, never omitted: the route requires the key and the console sets no ceiling
  newTask: async (input: { title: string; spec?: string; parentId?: string; grounded?: GroundedSpec }): Promise<string> =>
    (await api.act<{ taskId: string }>('newTask', { ...input, budgetUSD: null }, S.TaskCreated)).taskId,

  // edit reopens a blocked plan as a new editable version; no model call
  edit: (taskId: string, draft: { strategyRef: string; costEstimateUSD: number | null; steps: unknown[] }): Promise<{ version: number }> =>
    api.act<{ version: number }>('edit', { taskId, draft }, S.ApprovedVersion),

  propose: (taskId: string, modelRef: string, skillRefs?: string[]): Promise<unknown> =>
    api.act('propose', { taskId, modelRef, ...(skillRefs?.length ? { skillRefs } : {}) }),

  approve: (taskId: string, version?: number): Promise<{ version: number }> =>
    api.act<{ version: number }>('approve', { taskId, ...(version !== undefined && { version }) }, S.ApprovedVersion),

  run: (taskId: string, cwd: string): Promise<unknown> => api.act('run', { taskId, cwd }),

  retry: (taskId: string): Promise<unknown> => api.act('retry', { taskId }),

  cancel: (taskId: string): Promise<unknown> => api.act('cancel', { taskId }),

  reply: (taskId: string, text: string): Promise<ReplyResult> => api.act<ReplyResult>('reply', { taskId, text }, S.ReplyResult),

  /** annotate ONE plan note — the planner reads it on its next revise */
  annotate: (taskId: string, noteId: string, text: string, refs?: string[]): Promise<unknown> =>
    api.act('annotate', { taskId, noteId, text, ...(refs?.length ? { refs } : {}) }),

  /** annotate every note in `scope`, then wake the plan agent to revise just those */
  revise: (taskId: string, text: string, scope: string[]): Promise<unknown> => api.act('revise', { taskId, text, scope }),

  renameProject: (name: string): Promise<unknown> => api.act('renameProject', { name }),
  newProject: (dir: string, name: string): Promise<unknown> => api.act('newProject', { dir, name }),
  purgeProject: (): Promise<PurgeReport> => api.act<PurgeReport>('purgeProject', {}, S.PurgeReport),
  deleteProject: (projectId: string): Promise<PurgeReport> => api.act<PurgeReport>('deleteProject', { projectId }, S.PurgeReport),
} as const

// A foreign project's append is durable but may have no supervisor: never claim a resumption
export const replyReceipt = (r: ReplyResult): { text: string; tone: 'ok' | 'warn' } =>
  !r.answered
    ? { text: 'no open question left to answer — it was answered elsewhere', tone: 'warn' }
    : r.supervised
      ? { text: 'replied — step resuming', tone: 'ok' }
      : { text: 'answer saved — no supervisor is running that project, so it stays queued until one starts', tone: 'warn' }
