// every fetch goes through get/post: one error surface, one URL builder, one schema check
import type { z } from 'zod'
import type { GraphSnapshot, Health, ProjectEntry, SessionInfo } from './types'
import { describeZodError } from './parse'
import * as S from './schemas'

export class ApiError extends Error {
  constructor(
    readonly endpoint: string,
    message: string,
  ) {
    super(message)
  }
}

let onError: ApiErrorHandler = () => {}
export type ApiErrorHandler = (err: ApiError) => void
export const setApiErrorHandler = (fn: ApiErrorHandler): ApiErrorHandler => {
  const previous = onError
  onError = fn
  return previous
}

// view-client.ts's fetchView reports a failed view read through this SAME toast surface, rather
// than a second error-handler registry — one place an endpoint failure reaches the operator.
export const reportApiError = (err: ApiError): void => onError(err)

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
 *
 * No `nullOn404` here: every read left on this surface (session/projects/graph/health) always
 * answers something. The views that legitimately 404 (`plans`, `planNotes`) go through
 * view-client.ts's `fetchView`, which owns that case beside the registry that decides it.
 */
async function get<T>(endpoint: string, schema: z.ZodType<T>, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const res = await fetch(`/api/${endpoint}${qs(params)}`)
  if (!res.ok) {
    const err = new ApiError(endpoint, await res.text().catch(() => res.statusText))
    onError(err)
    throw err
  }
  const parsed = schema.safeParse(await res.json())
  if (!parsed.success) {
    const err = new ApiError(endpoint, `response did not match the expected shape — ${describeZodError(parsed.error)}`)
    onError(err)
    throw err
  }
  return parsed.data
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
    const err = new ApiError(endpoint, `result did not match the expected shape — ${describeZodError(parsed.error)}`)
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
  act: <T = unknown>(name: string, body: unknown, schema?: z.ZodType<unknown>) => post<T>(`actions/${name}`, body, schema),
}
