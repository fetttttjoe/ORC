import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import type { SupervisorRow } from '@orc/kernel'
import { ensureSupervisor, SUPERVISOR_MODE } from './supervisor-client'

const row: SupervisorRow = { executorId: 'a', pid: 1, host: 'box', startedAt: '', lastSeenAt: '' }
// lazy, like `spawn`: read only after spawn has run, never under --no-daemon
const config = () => ({ projectRoot: '/proj' })

describe('ensureSupervisor', () => {
  it('does not spawn when one is already live', async () => {
    let spawned = 0
    const r = await ensureSupervisor({
      live: async () => [row], spawn: () => { spawned++ }, waitMs: 100, noDaemon: false, sleep: async () => {}, config,
    })
    expect([r, spawned]).toEqual([SUPERVISOR_MODE.live, 0])
  })

  it('spawns and waits until a heartbeat appears', async () => {
    let spawned = 0
    let calls = 0
    const r = await ensureSupervisor({
      live: async () => (++calls > 2 ? [row] : []), spawn: () => { spawned++ }, waitMs: 5_000, noDaemon: false, sleep: async () => {}, config,
    })
    expect([r, spawned]).toEqual([SUPERVISOR_MODE.spawned, 1])
  })

  // the log lives under the MAIN checkout's projectRoot: the message must route through serveLogFile
  it('reports the real serve log path for this project when the spawned supervisor never beats', async () => {
    await expect(ensureSupervisor({
      live: async () => [], spawn: () => {}, waitMs: 0, noDaemon: false, sleep: async () => {}, config,
    })).rejects.toThrow(path.join('/proj', '.orc', 'serve.log'))
  })

  it('never spawns under --no-daemon: the command runs its own runtime, as it always did', async () => {
    let spawned = 0
    const r = await ensureSupervisor({
      live: async () => [], spawn: () => { spawned++ }, waitMs: 100, noDaemon: true, sleep: async () => {}, config,
    })
    expect([r, spawned]).toEqual([SUPERVISOR_MODE.inProcess, 0])
  })
})
