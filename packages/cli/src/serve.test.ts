import { afterAll, describe, expect, it } from 'bun:test'
import { liveSupervisors, openStorage, supervisors, SUPERVISOR_STALE_MS } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { claimSlot, nextIdle } from './serve'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

async function fresh() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  return storage
}

describe('claimSlot (admission IS slot claiming, not a second rule)', () => {
  it('no live rows claims slot 1', async () => {
    const storage = await fresh()
    expect(await claimSlot(storage, 1)).toBe('supervisor-1')
  })

  it('a live foreign row yields null at maxSlots: 1', async () => {
    const storage = await fresh()
    const now = new Date()
    await storage.db.insert(supervisors).values({
      projectId: storage.projectId, executorId: 'supervisor-1', pid: 999, host: 'other-box',
      startedAt: now, lastSeenAt: now,
    })
    expect(await claimSlot(storage, 1)).toBeNull()
  })

  it('a stale row for slot 1 is reclaimed (same id back)', async () => {
    const storage = await fresh()
    const stale = new Date(Date.now() - SUPERVISOR_STALE_MS - 1_000)
    await storage.db.insert(supervisors).values({
      projectId: storage.projectId, executorId: 'supervisor-1', pid: 999, host: 'other-box',
      startedAt: stale, lastSeenAt: stale,
    })
    expect(await claimSlot(storage, 1)).toBe('supervisor-1')
  })

  // The property the whole stable-slot design rests on (see docs/superpowers/specs/
  // 2026-07-25-supervisor-runtime-design.md): a restarted supervisor gets the SAME executor id
  // back by reclaiming its OWN row, not by racing a fresh INSERT next to a stale leftover. At
  // maxSlots: 1 the id alone can't tell a genuine upsert from any other implementation that
  // happens to also return 'supervisor-1' — the row count and the rewritten startedAt can.
  it('a restarted supervisor reclaims its OWN row: same id, no second row, startedAt genuinely advances', async () => {
    const storage = await fresh()

    // "boot 1"
    expect(await claimSlot(storage, 1)).toBe('supervisor-1')
    const before = (await liveSupervisors(storage, new Date()))[0]!

    // simulate a crash: the row goes stale (no clean `forget` — last_seen_at just stops advancing)
    const stale = new Date(Date.now() - SUPERVISOR_STALE_MS - 1_000)
    await storage.db.insert(supervisors)
      .values({ projectId: storage.projectId, executorId: 'supervisor-1', pid: 1, host: 'x', startedAt: stale, lastSeenAt: stale })
      .onConflictDoUpdate({
        target: [supervisors.projectId, supervisors.executorId],
        set: { startedAt: stale, lastSeenAt: stale },
      })

    // "boot 2" — a fresh process claims again
    expect(await claimSlot(storage, 1)).toBe('supervisor-1')
    const live = await liveSupervisors(storage, new Date())

    expect(live).toHaveLength(1) // reclaimed the SAME row — a second INSERT would show up here too
    expect(new Date(live[0]!.startedAt).getTime()).toBeGreaterThan(new Date(before.startedAt).getTime()) // DO UPDATE genuinely fired, not a no-op
  })
})

describe('nextIdle (the idle-exit decision, without waiting through it)', () => {
  it('busy resets the clock', () => {
    expect(nextIdle(true, 12_345, 20_000, 1_000)).toEqual({ idleSince: null, timedOut: false })
  })

  it('going quiet starts the clock but does not time out yet', () => {
    expect(nextIdle(false, null, 10_000, 5_000)).toEqual({ idleSince: 10_000, timedOut: false })
  })

  it('idle carries forward and times out once idleMs has elapsed', () => {
    expect(nextIdle(false, 10_000, 14_999, 5_000)).toEqual({ idleSince: 10_000, timedOut: false })
    expect(nextIdle(false, 10_000, 15_000, 5_000)).toEqual({ idleSince: 10_000, timedOut: true })
  })
})
