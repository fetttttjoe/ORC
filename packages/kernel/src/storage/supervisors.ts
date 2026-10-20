import { hostname } from 'node:os'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { supervisors } from '../schema'
import type { Storage } from './index'

// six missed beats before a row is presumed dead: a GC pause cannot evict a healthy supervisor
export const SUPERVISOR_BEAT_MS = 5_000
export const SUPERVISOR_STALE_MS = 30_000

export interface SupervisorRow {
  executorId: string
  pid: number
  host: string
  startedAt: string
  lastSeenAt: string
}

const toRow = (r: typeof supervisors.$inferSelect): SupervisorRow => ({
  executorId: r.executorId,
  pid: r.pid,
  host: r.host,
  startedAt: r.startedAt.toISOString(),
  lastSeenAt: r.lastSeenAt.toISOString(),
})

export async function beat(storage: Storage, executorId: string, pid: number, host: string): Promise<void> {
  const now = new Date()
  await storage.db
    .insert(supervisors)
    .values({ projectId: storage.projectId, executorId, pid, host, startedAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [supervisors.projectId, supervisors.executorId],
      set: { lastSeenAt: now, pid, host },
    })
}

// one atomic claim: insert, or take over a row stale past the window, never a live one
export async function claimSlot(storage: Storage, maxSlots: number): Promise<string | null> {
  const pid = process.pid
  const host = hostname()
  for (let slot = 1; slot <= maxSlots; slot++) {
    const executorId = `supervisor-${slot}`
    const result = await storage.db.execute(sql`
      INSERT INTO supervisors (project_id, executor_id, pid, host, started_at, last_seen_at)
      VALUES (${storage.projectId}, ${executorId}, ${pid}, ${host}, now(), now())
      ON CONFLICT (project_id, executor_id) DO UPDATE
        SET pid = excluded.pid, host = excluded.host, started_at = now(), last_seen_at = now()
        WHERE supervisors.last_seen_at < now() - interval '1 second' * ${SUPERVISOR_STALE_MS / 1000}
      RETURNING executor_id
    `)
    if (result.rows.length > 0) return executorId
  }
  return null
}

const since = (now: Date): Date => new Date(now.getTime() - SUPERVISOR_STALE_MS)

export async function liveSupervisors(storage: Storage, now: Date): Promise<SupervisorRow[]> {
  const rows = await storage.db.select().from(supervisors)
    .where(and(eq(supervisors.projectId, storage.projectId), gte(supervisors.lastSeenAt, since(now))))
  return rows.map(toRow)
}

export async function staleSupervisors(storage: Storage, now: Date): Promise<SupervisorRow[]> {
  const rows = await storage.db.select().from(supervisors)
    .where(and(eq(supervisors.projectId, storage.projectId), lt(supervisors.lastSeenAt, since(now))))
  return rows.map(toRow)
}

export async function forget(storage: Storage, executorId: string): Promise<void> {
  await storage.db.delete(supervisors)
    .where(and(eq(supervisors.projectId, storage.projectId), eq(supervisors.executorId, executorId)))
}
