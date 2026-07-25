import { describe, expect, it } from 'bun:test'
import type { SupervisorRow } from '@orc/kernel'
import { ensureSupervisor, SUPERVISOR_MODE } from './supervisor-client'

const row: SupervisorRow = { executorId: 'a', pid: 1, host: 'box', startedAt: '', lastSeenAt: '' }

describe('ensureSupervisor', () => {
  it('does not spawn when one is already live', async () => {
    let spawned = 0
    const r = await ensureSupervisor({
      live: async () => [row], spawn: () => { spawned++ }, waitMs: 100, noDaemon: false, sleep: async () => {},
    })
    expect([r, spawned]).toEqual([SUPERVISOR_MODE.live, 0])
  })

  it('spawns and waits until a heartbeat appears', async () => {
    let spawned = 0
    let calls = 0
    const r = await ensureSupervisor({
      live: async () => (++calls > 2 ? [row] : []), spawn: () => { spawned++ }, waitMs: 5_000, noDaemon: false, sleep: async () => {},
    })
    expect([r, spawned]).toEqual([SUPERVISOR_MODE.spawned, 1])
  })

  it('reports where to look when the spawned supervisor never beats', async () => {
    await expect(ensureSupervisor({
      live: async () => [], spawn: () => {}, waitMs: 0, noDaemon: false, sleep: async () => {},
    })).rejects.toThrow(/\.orc\/serve\.log/)
  })

  it('never spawns under --no-daemon: the command runs its own runtime, as it always did', async () => {
    let spawned = 0
    const r = await ensureSupervisor({
      live: async () => [], spawn: () => { spawned++ }, waitMs: 100, noDaemon: true, sleep: async () => {},
    })
    expect([r, spawned]).toEqual([SUPERVISOR_MODE.inProcess, 0])
  })
})
