import type { MemoryAuthor, ResolvedTool } from '@orc/contracts'
import { EventLog, type OrcConfig } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { createMemoryStore } from './store'
import { createMemoryProjector, type MemoryProjector } from './projector'
import { memoryTools } from './tools'

export { SurrealMemory } from './surreal'
export { createMemoryStore } from './store'
export { createMemoryProjector } from './projector'
export { memoryTools } from './tools'
export { renderNoteFile, noteRelPath } from './note-md'

export async function createMemory(opts: { log: EventLog; config: OrcConfig }): Promise<{
  store: ReturnType<typeof createMemoryStore>
  projector: MemoryProjector
  buildTools: (author: MemoryAuthor) => ResolvedTool[]
  close: () => Promise<void>
}> {
  new URL(opts.config.projectDbUrl) // fail fast on a malformed setting; the adapter takes the raw string
  const surreal = await SurrealMemory.open({ url: opts.config.projectDbUrl, ns: 'orc', db: 'memory' })
  const store = createMemoryStore({ log: opts.log, surreal })
  const projector = createMemoryProjector({ log: opts.log, surreal, vaultDir: opts.config.vaultDir })
  return {
    store, projector,
    buildTools: author => memoryTools(store, author),
    close: async () => { await projector.close(); await surreal.close() },
  }
}
