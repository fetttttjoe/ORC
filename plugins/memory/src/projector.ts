import { EVENT_KIND, MemoryDeletedPayload, MemoryWrittenPayload, type EventRecord } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { deleteMemoryFile, writeMemoryFile } from './write-note'
import { rebuildVaultMemory } from './memory-index'

export interface MemoryProjector { start(): Promise<void>; close(): Promise<void>; rebuild(): Promise<void>; catchUp(): Promise<void> }

const MEMORY_KINDS = [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted]

export function createMemoryProjector(opts: { log: EventLog; surreal: SurrealMemory; vaultDir: string }): MemoryProjector {
  const { log, surreal, vaultDir } = opts
  let unsub: (() => Promise<void>) | null = null
  let applying: Promise<void> = Promise.resolve()

  // Surreal commits note+edges+cursor in ONE transaction (applyEvent); the vault file is
  // written only after an accepted apply. A crash between the two heals on the next
  // start/catchUp/rebuild, which replaces vault/memory/** from current Surreal state.
  const applyOne = async (e: EventRecord): Promise<void> => {
    const applied = await surreal.applyEvent(e)
    if (!applied) return
    if (e.kind === EVENT_KIND.memory_written) {
      const { note } = MemoryWrittenPayload.parse(e.payload)
      const full = await surreal.get(note.id, note.scope)
      if (full) writeMemoryFile(vaultDir, noteRelPath(full), renderNoteFile(full))
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = MemoryDeletedPayload.parse(e.payload)
      deleteMemoryFile(vaultDir, noteRelPath(p))
    }
  }

  // Reconcile by querying the log WHERE seq > cursor rather than trusting the subscribe
  // payload's ordering. Callers are responsible for serializing calls (see `serialize`
  // below) so revision/ordering stays deterministic.
  const drainFrom = async (fromSeq: number): Promise<number> => {
    const events = await log.after(fromSeq, MEMORY_KINDS)
    for (const e of events) await applyOne(e)
    return surreal.getCursor()
  }

  // Every drain/clear goes through this so two passes (e.g. a subscribe notification firing
  // during a rebuild()) never interleave — the whole instance applies serially.
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = applying.then(fn, fn) // run after prior settles (success OR failure)
    applying = next.then(() => {}, () => {}) // keep the chain alive, swallow to avoid unhandled rejection
    return next
  }

  let cursorCache = 0
  const enqueueReconcile = (): void => {
    void serialize(async () => {
      try {
        cursorCache = await drainFrom(cursorCache)
      } catch (err) {
        console.warn(`memory projector: ${err instanceof Error ? err.message : String(err)}`)
        cursorCache = await surreal.getCursor() // resume after last applied event; don't re-apply succeeded ones
      }
    })
  }

  return {
    start: async () => {
      await serialize(async () => {
        cursorCache = await drainFrom(await surreal.getCursor())
        await rebuildVaultMemory(surreal, vaultDir)
      })
      unsub = await log.subscribe({}, () => enqueueReconcile())
    },
    close: async () => { if (unsub) { await unsub(); unsub = null } await applying },
    rebuild: async () => {
      await serialize(async () => {
        await surreal.clear()
        cursorCache = await drainFrom(0)
        await rebuildVaultMemory(surreal, vaultDir)
      })
    },
    // one-shot drain from the persisted cursor (no clear, no subscription) — the CLI's projection path
    catchUp: async () => {
      await serialize(async () => {
        cursorCache = await drainFrom(await surreal.getCursor())
        await rebuildVaultMemory(surreal, vaultDir)
      })
    },
  }
}
