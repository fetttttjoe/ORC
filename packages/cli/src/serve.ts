import { hostname } from 'node:os'
import { errorMessage, SUPERVISOR_HEALTH, TASK_STATUS, type SupervisorHealth } from '@orc/contracts'
import { beat, claimSlot, forget, SUPERVISOR_BEAT_MS, type DbosPort, type Storage, type SupervisorRow } from '@orc/kernel'

// The admission rule this project keeps at Phase 1 (N=1): claiming re-exported from kernel's
// storage layer, where the raw-SQL atomic statement belongs — storage/index.ts's `db`/`projectId`
// escape hatch exists FOR this table (see storage/supervisors.ts), and the cli package holds no
// drizzle-orm dependency of its own. A null claim IS the refusal; there is no second rule to agree
// or disagree with it.
export { claimSlot }

// The boot-window heartbeat. runSupervisor's beat starts only once the runtime is BUILT, and
// buildRuntime blocks on projection catch-up — measured 2026-08-01: a wiped read model held boot
// for the better part of an hour, during which the claimed slot read STALE on a live pid, `orc
// serve status` reported a hang, and a second `orc serve` could steal the slot mid-boot. Beating
// from claim until the runtime is up keeps admission honest for however long boot takes; the
// caller stops this and hands over to runSupervisor's own beat. Interval injectable so the test
// observes real beats without waiting through SUPERVISOR_BEAT_MS.
export function startBootHeartbeat(
  storage: Storage, executorId: string, intervalMs: number = SUPERVISOR_BEAT_MS,
): () => void {
  const timer = setInterval(() => {
    void beat(storage, executorId, process.pid, hostname())
      .catch(err => console.warn(`boot heartbeat: ${errorMessage(err)}`))
  }, intervalMs)
  return () => clearInterval(timer)
}

// The "is anything driving?" classifier — pure over the two heartbeat queries plus the pid-file
// probe, so the answer is a table and not a judgment scattered across render sites. Ready needs
// BOTH signals: the heartbeat row proves the process lives (startBootHeartbeat beats through
// boot), and the pid file is written only once buildRuntime returned — so heartbeat-without-file
// is precisely "booting". A pid file with no heartbeat proves nothing: liveness is the row.
export function supervisorHealth(
  live: ReadonlyArray<Pick<SupervisorRow, 'pid' | 'lastSeenAt'>>,
  stale: ReadonlyArray<Pick<SupervisorRow, 'pid' | 'lastSeenAt'>>,
  pidFilePresent: boolean,
  // "is anything DRIVING" — a different fact from the heartbeat, and the one that decides whether
  // work can run. Defaults false so an unreadable lock never manufactures a driver.
  runtimeHeld = false,
): SupervisorHealth {
  const l = live[0]
  if (l) return { state: pidFilePresent ? SUPERVISOR_HEALTH.ready : SUPERVISOR_HEALTH.booting, pid: l.pid, lastSeenAt: l.lastSeenAt }
  // BEFORE stale on purpose: a stale row says a supervisor died without cleaning up, but a held
  // lock says something is driving right now. The second is what the operator can act on.
  if (runtimeHeld) return { state: SUPERVISOR_HEALTH.client }
  const s = stale[0]
  if (s) return { state: SUPERVISOR_HEALTH.stale, pid: s.pid, lastSeenAt: s.lastSeenAt }
  return { state: SUPERVISOR_HEALTH.none }
}

// Pure so the idle-exit timer is a table of inputs → outputs, not a 30-second sleep a test has to
// wait through. `busy` resets the clock; otherwise `idleSince` carries forward from the previous
// tick (or starts now) and `timedOut` fires once idleMs has elapsed since the project went quiet.
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

// Beats every SUPERVISOR_BEAT_MS until SIGINT/SIGTERM or the project has had no running task for
// idleMs, then forgets its own row and resolves — a clean stop and a crash look identical to the
// next client either way (the row is gone, or it goes stale on its own). The interval and the
// signal race inside one Promise so both paths converge on the same teardown exactly once.
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
