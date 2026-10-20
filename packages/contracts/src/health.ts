import { z } from 'zod'

// The health vocabulary every surface reports through, zod-only so the browser bundle can take it.
export enum KnowledgeHealthState { ok = 'ok', unavailable = 'unavailable' }
export const KnowledgeHealth = z.discriminatedUnion('state', [
  z.object({ state: z.literal(KnowledgeHealthState.ok), claims: z.number().int().nonnegative(), suspect: z.number().int().nonnegative() }),
  z.object({ state: z.literal(KnowledgeHealthState.unavailable), reason: z.string() }),
])
export type KnowledgeHealth = z.infer<typeof KnowledgeHealth>

export enum SupervisorHealthState { ready = 'ready', booting = 'booting', stale = 'stale', client = 'client', none = 'none' }
export interface SupervisorHealth {
  state: SupervisorHealthState
  pid?: number
  lastSeenAt?: string
}
