import type { SupervisorRow } from '@orc/kernel'

// How this command reaches a runtime: one already beating, one this command started, or none at
// all because --no-daemon says the command holds its own. Named, so the three cases are matched
// against a vocabulary rather than against string literals spread over caller and test.
export const SUPERVISOR_MODE = { live: 'live', spawned: 'spawned', inProcess: 'in-process' } as const
export type SupervisorMode = (typeof SUPERVISOR_MODE)[keyof typeof SUPERVISOR_MODE]

export interface EnsureDeps {
  live: () => Promise<SupervisorRow[]>
  spawn: () => void
  waitMs: number
  noDaemon: boolean
  sleep: (ms: number) => Promise<void>
}

const POLL_MS = 100

// Guarantee a supervisor exists before acting as a client. Two clients racing both spawn; the
// loser's supervisor fails to claim a slot and exits, and both clients then see one — so no
// coordination beyond the heartbeat is needed. Under --no-daemon the caller runs the runtime in
// process instead, which is what tests, CI and the bench harness need for determinism.
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
  throw new Error('no supervisor came up — see .orc/serve.log, or re-run with --no-daemon to execute in this process')
}
