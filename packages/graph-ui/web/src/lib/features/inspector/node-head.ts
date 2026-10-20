// Slice of the node view the tab headers read; a shape miss means no head, never a crash
import { z } from 'zod'

// task detail nests {task, usage}; other kinds may carry title/status at the top level
const TaskHead = z.looseObject({ title: z.string().optional(), status: z.string().optional() })
const UsageHead = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUSD: z.number().nullable().optional(),
})
const NodeHead = z.looseObject({
  ...TaskHead.shape,
  task: TaskHead.optional(),
  usage: UsageHead.optional(),
})

export const TASK_KEY = 'task'
/** top-level keys the head consumes — the generic grid skips them once the head rendered */
export const HEAD_KEYS: readonly string[] = Object.keys(NodeHead.shape).filter(k => k !== TASK_KEY)
/** fields the head lifts out of a nested task record */
export const TASK_HEAD_KEYS: readonly string[] = Object.keys(TaskHead.shape)

export interface Head {
  title: string | undefined
  status: string | undefined
  costUSD: number | null
  tokens: number | null
}

export const nodeHead = (data: unknown): Head | null => {
  const r = NodeHead.safeParse(data)
  if (!r.success) return null
  const tokens = (r.data.usage?.inputTokens ?? 0) + (r.data.usage?.outputTokens ?? 0)
  return {
    title: r.data.title ?? r.data.task?.title,
    status: r.data.status ?? r.data.task?.status,
    costUSD: r.data.usage?.costUSD ?? null,
    tokens: tokens > 0 ? tokens : null,
  }
}

// null = unpriced, NOT zero: '$0.000' would claim a measurement nobody made
export const fmtCost = (usd: number | null | undefined): string => (usd == null ? 'unpriced' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`)
export const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
export const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
