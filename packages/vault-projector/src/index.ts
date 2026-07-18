import { EVENT_KIND } from '@orc/contracts'
import { fold, type EventLog } from '@orc/kernel'
import { renderRootIndex, renderTaskFiles } from './render'
import { writeVaultFiles } from './write'

export { frontmatter } from './frontmatter'
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
    // task lifecycle only — the root index must never scan the whole log
    const lifecycle = await log.after(0, [EVENT_KIND.task_created, EVENT_KIND.task_status_changed])
    const tasks = [...fold(lifecycle).tasks.values()]
    writeVaultFiles(vaultDir, { 'index.md': renderRootIndex(tasks) })
  }
  const renderTask = async (taskId: string): Promise<void> => {
    writeVaultFiles(vaultDir, renderTaskFiles(taskId, await log.byTask(taskId)))
    await renderRoot()
  }
  const renderAll = async (): Promise<void> => {
    const created = await log.after(0, [EVENT_KIND.task_created])
    const ids = new Set(created.flatMap(e => (e.taskId ? [e.taskId] : [])))
    for (const id of ids) writeVaultFiles(vaultDir, renderTaskFiles(id, await log.byTask(id)))
    await renderRoot()
  }

  return {
    renderTask, renderAll,
    start: async () => {
      await renderAll()
      unsub = await log.subscribe({}, e => {
        if (!e.taskId) return // ponytail: memory events are project-scoped, not task-scoped
        const taskId = e.taskId
        const prev = timers.get(taskId)
        if (prev) clearTimeout(prev)
        // coalesce a burst into one render per task (spec §5) — not a poll
        timers.set(taskId, setTimeout(() => {
          timers.delete(taskId)
          renderTask(taskId).catch(err => console.warn(`vault render failed: ${err instanceof Error ? err.message : String(err)}`))
        }, 50))
      })
    },
    close: async () => {
      if (!unsub) { for (const t of timers.values()) clearTimeout(t); timers.clear(); return }
      await unsub(); unsub = null
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      await renderAll()   // final authoritative sync — vault matches the committed log at close
    },
  }
}
