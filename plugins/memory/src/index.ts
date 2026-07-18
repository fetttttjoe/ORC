import { EVENT_KIND, type MemoryAuthor, type MemoryStore, type ResolvedTool } from '@orc/contracts'
import { EventLog, projectDatabaseName, type ProjectConfig } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { createMemoryStore } from './store'
import { createMemoryProjector, type MemoryProjector } from './projector'
import { memoryTools } from './tools'

export { SurrealMemory } from './surreal'
export { createMemoryStore } from './store'
export { createMemoryProjector } from './projector'
export { memoryTools, unavailableMemoryTools } from './tools'
export { renderMemoryIndex, rebuildVaultMemory } from './memory-index'
export { renderNoteFile, noteRelPath } from './note-md'

// the actual revision of the code the runtime is looking at — null outside Git
export async function gitRevision(dir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', dir, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() : null
  } catch {
    return null
  }
}

// SurrealDB's native database boundary isolates projects: the session is opened on a
// name derived from (base, projectId), so tool inputs can never reach another project.
const surrealTarget = (config: ProjectConfig) => ({
  url: config.projectDbUrl,
  ns: config.projectDbNamespace,
  db: projectDatabaseName(config.projectDbName, config.projectId),
  username: config.projectDbUser,
  password: config.projectDbPassword,
})

export async function createMemory(opts: { log: EventLog; config: ProjectConfig }): Promise<{
  store: MemoryStore
  projector: MemoryProjector
  buildTools: (author: MemoryAuthor) => ResolvedTool[]
  close: () => Promise<void>
}> {
  new URL(opts.config.projectDbUrl) // fail fast on a malformed setting; the adapter takes the raw string
  const surreal = await SurrealMemory.open(surrealTarget(opts.config))
  const store = createMemoryStore({ log: opts.log, surreal, sourceRevision: await gitRevision(opts.config.dir) })
  const projector = createMemoryProjector({ log: opts.log, surreal, vaultDir: opts.config.vaultDir })
  return {
    store, projector,
    buildTools: author => memoryTools(store, author),
    close: async () => { await projector.close(); await surreal.close() },
  }
}

// healthy = reachable AND caught up with the log's memory events
export async function probeMemory(
  config: ProjectConfig,
  log: EventLog,
): Promise<{ healthy: true } | { healthy: false; reason: string }> {
  try {
    new URL(config.projectDbUrl)
    const surreal = await SurrealMemory.open(surrealTarget(config))
    const cursor = await surreal.getCursor()
    const pending = (await log.after(cursor, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted])).length
    await surreal.close()
    return pending === 0 ? { healthy: true } : { healthy: false, reason: `${pending} unapplied events` }
  } catch (err) {
    return { healthy: false, reason: `unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}
