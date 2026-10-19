import { z } from 'zod'

// The health vocabulary every surface reports through, zod-only so the browser bundle can take it.
export enum KnowledgeHealthState { ok = 'ok', unavailable = 'unavailable' }
export const KnowledgeHealth = z.discriminatedUnion('state', [
  z.object({ state: z.literal(KnowledgeHealthState.ok), claims: z.number().int().nonnegative(), suspect: z.number().int().nonnegative() }),
  z.object({ state: z.literal(KnowledgeHealthState.unavailable), reason: z.string() }),
])
export type KnowledgeHealth = z.infer<typeof KnowledgeHealth>

// Whether anything can DRIVE a run right now — the question every silent project raises first.
// Derived from the supervisor heartbeat row plus the pid file the serve process writes only once
// its runtime is ready: heartbeat+pidfile = ready, heartbeat alone = booting, a stale row = it
// died without cleanup, no row = nothing will run until `orc serve`.
// `client` is not a supervisor at all: the execution runtime is held by a `--no-daemon` command or
// the graph server. It exists because `none` was rendered as "nothing will run" on the absence of a
// heartbeat alone, which is false whenever something else holds the lock.
export const SUPERVISOR_HEALTH_STATES = ['ready', 'booting', 'stale', 'client', 'none'] as const
export const SUPERVISOR_HEALTH = { ready: 'ready', booting: 'booting', stale: 'stale', client: 'client', none: 'none' } as const
export type SupervisorHealthState = (typeof SUPERVISOR_HEALTH)[keyof typeof SUPERVISOR_HEALTH]
export interface SupervisorHealth {
  state: SupervisorHealthState
  pid?: number
  lastSeenAt?: string
}
