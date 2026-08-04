// every fetch goes through get/post: one error surface, one URL builder, one schema check
import type { z } from 'zod'
import type { GraphSnapshot, Health, LogRow, NodeDetail, PlanNotesView, PlansView, ProjectEntry, SessionInfo, TranscriptItem } from './types'
import * as S from './schemas'

export class ApiError extends Error {
  constructor(
    readonly endpoint: string,
    message: string,
  ) {
    super(message)
  }
}

let onError: (err: ApiError) => void = () => {}
export const setApiErrorHandler = (fn: (err: ApiError) => void): void => {
  onError = fn
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

/**
 * Fetch and PARSE. The schema is the contract: a server that renames or re-nests a field fails
 * here, once, naming the endpoint and the path — instead of every consumer of that field quietly
 * rendering nothing. Callers still get their declared type, now earned rather than asserted.
 */
async function get<T>(
  endpoint: string,
  schema: z.ZodType<unknown>,
  params: Record<string, string | number | undefined> = {},
  opts?: { nullOn404?: boolean },
): Promise<T> {
  const res = await fetch(`/api/${endpoint}${qs(params)}`)
  if (res.status === 404 && opts?.nullOn404) return null as T
  if (!res.ok) {
    const err = new ApiError(endpoint, await res.text().catch(() => res.statusText))
    onError(err)
    throw err
  }
  const parsed = schema.safeParse(await res.json())
  if (!parsed.success) {
    const where = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 3).join('; ')
    const err = new ApiError(endpoint, `response did not match the expected shape — ${where}`)
    onError(err)
    throw err
  }
  return parsed.data as T
}

// CSRF: the server 403s any mutation without the per-boot token from /api/session, and actions
// additionally carry the active project so a foreign chat's write dies loudly server-side
let csrf = { token: '', project: '' }
export const setAuth = (token: string, project: string): void => {
  csrf = { token, project }
}
export const authHeaders = (): Record<string, string> => ({
  'x-orc-token': csrf.token,
  'x-orc-project': csrf.project,
  'content-type': 'application/json',
})

async function post<T>(endpoint: string, body: unknown, schema?: z.ZodType<unknown>): Promise<T> {
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = new ApiError(endpoint, await res.text().catch(() => res.statusText))
    onError(err)
    throw err
  }
  const payload: unknown = await res.json()
  if (!schema) return payload as T // the caller reads nothing from this result
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const where = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 3).join('; ')
    const err = new ApiError(endpoint, `result did not match the expected shape — ${where}`)
    onError(err)
    throw err
  }
  return parsed.data as T
}

export const api = {
  session: () => get<SessionInfo>('session', S.SessionInfo),
  projects: () => get<ProjectEntry[]>('projects', S.ProjectList),
  graph: (project: string) => get<GraphSnapshot>('graph', S.GraphSnapshot, { project }),
  health: () => get<Health>('health', S.Health),
  log: (project: string, opts: { task?: string; limit?: number; sinceSeq?: number } = {}) =>
    get<LogRow[]>('log', S.LogRows, { project, task: opts.task, limit: opts.limit, since: opts.sinceSeq }),
  node: (project: string, node: string) => get<NodeDetail>('node', S.NodeDetail, { project, id: node }),
  transcript: (project: string, task: string, step?: string) => get<TranscriptItem[]>('transcript', S.Transcript, { project, task, step }),
  plans: (project: string, task: string) => get<PlansView | null>('plans', S.PlansView, { project, task }, { nullOn404: true }),
  planNotes: (project: string, task: string) => get<PlanNotesView | null>('plan-notes', S.PlanNotesView, { project, task }, { nullOn404: true }),
  models: (project: string) => get<string[]>('models', S.ModelRefs, { project }),
  act: <T = unknown>(name: string, body: unknown, schema?: z.ZodType<unknown>) => post<T>(`actions/${name}`, body, schema),
}
