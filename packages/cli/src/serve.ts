import { hostname } from 'node:os'
import { errorMessage, SupervisorHealthState, TASK_STATUS, type SupervisorHealth } from '@orc/contracts'
import { beat, claimSlot, forget, SUPERVISOR_BEAT_MS, type DbosPort, type Storage, type SupervisorRow } from '@orc/kernel'

// claiming lives in kernel's storage layer: a null claim IS the refusal, no second rule
export { claimSlot }

// beats from claim until the runtime is up: catch-up is unbounded and a stale slot can be stolen
export function startBootHeartbeat(
  storage: Storage, executorId: string, intervalMs: number = SUPERVISOR_BEAT_MS,
): () => void {
  const timer = setInterval(() => {
    void beat(storage, executorId, process.pid, hostname())
      .catch(err => console.warn(`boot heartbeat: ${errorMessage(err)}`))
  }, intervalMs)
  return () => clearInterval(timer)
}

// ready needs both: heartbeat without the pid file is booting; a pid file alone proves nothing
export function supervisorHealth(
  live: ReadonlyArray<Pick<SupervisorRow, 'pid' | 'lastSeenAt'>>,
  stale: ReadonlyArray<Pick<SupervisorRow, 'pid' | 'lastSeenAt'>>,
  pidFilePresent: boolean,
  // defaults false so an unreadable lock never manufactures a driver
  runtimeHeld = false,
): SupervisorHealth {
  const l = live[0]
  if (l) return { state: pidFilePresent ? SupervisorHealthState.ready : SupervisorHealthState.booting, pid: l.pid, lastSeenAt: l.lastSeenAt }
  // before stale on purpose: a held lock says something drives now, which an operator can act on
  if (runtimeHeld) return { state: SupervisorHealthState.client }
  const s = stale[0]
  if (s) return { state: SupervisorHealthState.stale, pid: s.pid, lastSeenAt: s.lastSeenAt }
  return { state: SupervisorHealthState.none }
}

// pure so the idle-exit timer is a table of inputs, not a sleep a test waits through
export function nextIdle(busy: boolean, idleSince: number | null, nowMs: number, idleMs: number):
  { idleSince: number | null; timedOut: boolean } {
  if (busy) return { idleSince: null, timedOut: false }
  const since = idleSince ?? nowMs
  return { idleSince: since, timedOut: nowMs - since >= idleMs }
}

async function hasLiveWork(port: DbosPort): Promise<boolean> {
  const state = await port.projectState()
  for (const task of state.tasks.values()) if (task.status === TASK_STATUS.running) return true
  return false
}

export interface SupervisorDeps {
  storage: Storage
  port: DbosPort
  idleMs: number
  now?: () => Date
}

// a clean stop and a crash look alike to the next client: the row is gone or goes stale
export async function runSupervisor(deps: SupervisorDeps): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const executorId = deps.port.executorId
  let idleSince: number | null = null

  await new Promise<void>(resolve => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      clearInterval(timer)
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      void forget(deps.storage, executorId)
        .catch(() => {}) // a stale row expires on its own; never block shutdown on it
        .then(resolve, resolve)
    }
    const timer = setInterval(() => {
      void (async () => {
        await beat(deps.storage, executorId, process.pid, hostname())
        const decision = nextIdle(await hasLiveWork(deps.port), idleSince, now().getTime(), deps.idleMs)
        idleSince = decision.idleSince
        if (decision.timedOut) stop()
      })().catch(err => console.warn(`supervisor heartbeat: ${errorMessage(err)}`))
    }, SUPERVISOR_BEAT_MS)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
