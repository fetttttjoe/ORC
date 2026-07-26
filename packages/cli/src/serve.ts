import { hostname } from 'node:os'
import { errorMessage, TASK_STATUS } from '@orc/contracts'
import { beat, claimSlot, forget, SUPERVISOR_BEAT_MS, type DbosPort, type Storage } from '@orc/kernel'

// The admission rule this project keeps at Phase 1 (N=1): claiming re-exported from kernel's
// storage layer, where the raw-SQL atomic statement belongs — storage/index.ts's `db`/`projectId`
// escape hatch exists FOR this table (see storage/supervisors.ts), and the cli package holds no
// drizzle-orm dependency of its own. A null claim IS the refusal; there is no second rule to agree
// or disagree with it.
export { claimSlot }

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
