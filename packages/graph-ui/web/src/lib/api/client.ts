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

// fetchView reports failed view reads through this same toast surface
export const reportApiError = (err: ApiError): void => onError(err)

const qs = (params: Record<string, string | number | undefined>): string => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

// Fetch and parse: a renamed field fails here naming the endpoint and path; 404s go via fetchView
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

// CSRF: mutations carry the per-boot token; actions also carry the active project
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
