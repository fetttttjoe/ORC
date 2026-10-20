import type { ProjectConfig, SupervisorRow } from '@orc/kernel'
import { serveLogFile } from './serve-paths'

// how this command reaches a runtime: beating, started here, or none (--no-daemon holds its own)
export const SUPERVISOR_MODE = { live: 'live', spawned: 'spawned', inProcess: 'in-process' } as const
export type SupervisorMode = (typeof SUPERVISOR_MODE)[keyof typeof SUPERVISOR_MODE]

export interface EnsureDeps {
  live: () => Promise<SupervisorRow[]>
  spawn: () => void
  waitMs: number
  noDaemon: boolean
  sleep: (ms: number) => Promise<void>
  // lazy like `spawn`: read only past the noDaemon guard, so tests and embedded hosts supply none
  config: () => Pick<ProjectConfig, 'projectRoot'>
}

const POLL_MS = 100

// racing clients both spawn; the loser fails to claim a slot and exits, so the heartbeat suffices
export async function ensureSupervisor(deps: EnsureDeps): Promise<SupervisorMode> {
  if (deps.noDaemon) return SUPERVISOR_MODE.inProcess
  if ((await deps.live()).length > 0) return SUPERVISOR_MODE.live
  deps.spawn()
  const deadline = Date.now() + deps.waitMs
  for (;;) {
    if ((await deps.live()).length > 0) return SUPERVISOR_MODE.spawned
    if (Date.now() >= deadline) break
    await deps.sleep(POLL_MS)
  }
  throw new Error(`no supervisor came up — see ${serveLogFile(deps.config())}, or re-run with --no-daemon to execute in this process`)
}
