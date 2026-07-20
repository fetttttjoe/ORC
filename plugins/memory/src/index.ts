import { type MemoryAuthor, type MemoryStore, type ResolvedTool } from '@orc/contracts'
import { EventLog, type ProjectConfig } from '@orc/kernel'
import { openKnowledge, type Knowledge } from './knowledge'
import { createMemoryStore } from './store'
import { createMemoryProjector, KNOWLEDGE_KINDS, type MemoryProjector } from './projector'
import { memoryTools, type MemoryTier } from './tools'

export { SurrealMemory } from './surreal'
export { openKnowledge, type Knowledge } from './knowledge'
export { createMemoryStore } from './store'
export { createMemoryProjector } from './projector'
export { memoryTools, unavailableMemoryTools, MEMORY_TIER, tierForRole, type MemoryTier } from './tools'
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

// the orchestrator: assembles the knowledge service + event log into the memory domain
// services (gateway, projector, tools) — the business logic never opens Surreal itself
export async function createMemory(opts: { log: EventLog; config: ProjectConfig }): Promise<{
  store: MemoryStore
  projector: MemoryProjector
  buildTools: (author: MemoryAuthor, tier?: MemoryTier) => ResolvedTool[]
  close: () => Promise<void>
}> {
  const knowledge = await openKnowledge(opts.config)
  const store = createMemoryStore({ log: opts.log, surreal: knowledge, sourceRevision: await gitRevision(opts.config.dir) })
  const projector = createMemoryProjector({ log: opts.log, surreal: knowledge, vaultDir: opts.config.vaultDir })
  return {
    store, projector,
    buildTools: (author, tier) => memoryTools(store, author, tier),
    close: async () => { await projector.close(); await knowledge.close() },
  }
}

// healthy = reachable AND caught up with the log's memory events
export async function probeMemory(
  config: ProjectConfig,
  log: EventLog,
): Promise<{ healthy: true } | { healthy: false; reason: string }> {
  let knowledge: Knowledge | undefined
  try {
    knowledge = await openKnowledge(config)
    const cursor = await knowledge.getCursor()
    const pending = await log.countAfter(cursor, KNOWLEDGE_KINDS)
    return pending === 0 ? { healthy: true } : { healthy: false, reason: `${pending} unapplied events` }
  } catch (err) {
    return { healthy: false, reason: `unreachable: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    // close even if getCursor/countAfter threw after a successful open (same leak class as open())
    await knowledge?.close().catch(() => {})
  }
}
