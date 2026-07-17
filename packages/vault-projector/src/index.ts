import { fold, type EventLog } from '@orc/kernel'
import { renderRootIndex, renderTaskFiles } from './render'
import { writeVaultFiles } from './write'

export { parsePlanFile, renderPlanFile } from './plan-md'
export { renderRootIndex, renderTaskFiles, type VaultFiles } from './render'
export { writeVaultFiles } from './write'

export interface VaultProjector {
  renderTask(taskId: string): Promise<void>
  renderAll(): Promise<void>
  start(): Promise<void>
  close(): Promise<void>
}

// Only vaultDir is consumed; a structural type keeps the projector decoupled from
// full OrcConfig (runtime passes the whole config; tests pass just { vaultDir }).
export function createVaultProjector(opts: { log: EventLog; config: { vaultDir: string } }): VaultProjector {
  const { log } = opts
  const vaultDir = opts.config.vaultDir
  let unsub: (() => Promise<void>) | null = null
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const renderRoot = async (): Promise<void> => {
    const tasks = [...fold(await log.all()).tasks.values()]
    writeVaultFiles(vaultDir, { 'index.md': renderRootIndex(tasks) })
  }
  const renderTask = async (taskId: string): Promise<void> => {
    writeVaultFiles(vaultDir, renderTaskFiles(taskId, await log.byTask(taskId)))
    await renderRoot()
  }
  const renderAll = async (): Promise<void> => {
    const byTask = new Set((await log.all()).map(e => e.taskId))
    for (const id of byTask) writeVaultFiles(vaultDir, renderTaskFiles(id, await log.byTask(id)))
    await renderRoot()
  }
  const flush = async (): Promise<void> => {
    const ids = [...timers.keys()]
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    for (const id of ids) await renderTask(id)
  }

  return {
    renderTask, renderAll,
    start: async () => {
      await renderAll()
      unsub = await log.subscribe({}, e => {
        const prev = timers.get(e.taskId)
        if (prev) clearTimeout(prev)
        // coalesce a burst into one render per task (spec §5) — not a poll
        timers.set(e.taskId, setTimeout(() => { timers.delete(e.taskId); void renderTask(e.taskId) }, 50))
      })
    },
    close: async () => {
      if (unsub) { await unsub(); unsub = null }
      await flush()
    },
  }
}
