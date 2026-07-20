import { EVENT_KIND, MemoryDeletedPayload, MemoryWrittenPayload, type EventRecord } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { deleteMemoryFile, writeMemoryFile } from './write-note'
import { rebuildVaultMemory, renderMemoryIndex } from './memory-index'

export interface MemoryProjector { start(): Promise<void>; close(): Promise<void>; rebuild(): Promise<void>; catchUp(): Promise<void> }

// Everything the projector drains.
export const MEMORY_KINDS = [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted, EVENT_KIND.memory_accessed]

// What "the read model is behind" means for HEALTH — derived from the drained set so a fourth
// kind is covered automatically, with the one exclusion stated rather than implied. An
// unprojected access leaves `hits` briefly stale; that is a lagging counter, not a knowledge
// graph an agent would read wrongly, and reporting it as degraded would cry wolf on every read.
export const KNOWLEDGE_KINDS = MEMORY_KINDS.filter(k => k !== EVENT_KIND.memory_accessed)

export function createMemoryProjector(opts: { log: EventLog; surreal: SurrealMemory; vaultDir: string }): MemoryProjector {
  const { log, surreal, vaultDir } = opts
  let unsub: (() => Promise<void>) | null = null
  let applying: Promise<void> = Promise.resolve()

  // Surreal commits note+edges+cursor in ONE transaction (applyEvent); the vault file is
  // written only after an accepted apply. A crash between the two heals on the next
  // start/catchUp/rebuild, which replaces vault/memory/** from current Surreal state.
  //
  // Returns whether the VAULT changed, not whether the event applied: memory_accessed moves a
  // counter that no rendered file carries, and reads are frequent — re-rendering index.md (every
  // note body, every time) on each one would make reading the graph cost more than writing it.
  const applyOne = async (e: EventRecord): Promise<boolean> => {
    const applied = await surreal.applyEvent(e)
    if (!applied) return false
    if (e.kind === EVENT_KIND.memory_written) {
      const { note } = MemoryWrittenPayload.parse(e.payload)
      const full = await surreal.get(note.id, note.scope)
      if (full) writeMemoryFile(vaultDir, noteRelPath(full), renderNoteFile(full))
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = MemoryDeletedPayload.parse(e.payload)
      deleteMemoryFile(vaultDir, noteRelPath(p))
    } else return false
    return true
  }

  // Reconcile by querying the log WHERE seq > cursor rather than trusting the subscribe
  // payload's ordering. Callers are responsible for serializing calls (see `serialize`
  // below) so revision/ordering stays deterministic.
  const drainFrom = async (fromSeq: number): Promise<{ cursor: number; vaultChanged: number }> => {
    const events = await log.after(fromSeq, MEMORY_KINDS)
    let vaultChanged = 0
    for (const e of events) if (await applyOne(e)) vaultChanged += 1
    return { cursor: await surreal.getCursor(), vaultChanged }
  }

  // Every drain/clear goes through this so two passes (e.g. a subscribe notification firing
  // during a rebuild()) never interleave — the whole instance applies serially.
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = applying.then(fn, fn) // run after prior settles (success OR failure)
    applying = next.then(() => {}, () => {}) // keep the chain alive, swallow to avoid unhandled rejection
    return next
  }

  // per-note files are written per accepted event; only the aggregate index needs a refresh
  const refreshIndex = async (): Promise<void> =>
    writeMemoryFile(vaultDir, 'index.md', renderMemoryIndex(await surreal.allNotes()))

  let cursorCache = 0
  let closed = false
  // transient socket/transaction drops (idle WS reset, 'Transaction not found') heal on the next
  // apply — one bounded retry absorbs them instead of warn-spamming a self-healing condition
  const connectionShaped = (err: unknown): boolean =>
    /connect|connection|socket|websocket|transaction not found/i.test(err instanceof Error ? err.message : String(err))
  const enqueueReconcile = (): void => {
    void serialize(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await drainFrom(cursorCache)
          cursorCache = r.cursor
          if (r.vaultChanged > 0) await refreshIndex()
          return
        } catch (err) {
          if (closed) return // shutdown race: the socket is gone because we are — expected, not a warning
          if (attempt === 1 && connectionShaped(err)) { await new Promise(r => setTimeout(r, 250)); continue }
          console.warn(`memory projector: ${err instanceof Error ? err.message : String(err)}`)
          // resume after last applied event; if even the cursor read fails, keep the old one —
          // applyEvent is idempotent per cursor, and an uncaught throw here would reject the
          // void-discarded serialize() promise as an unhandled rejection
          try { cursorCache = await surreal.getCursor() } catch { /* next drain re-reads */ }
          return
        }
      }
    })
  }

  return {
    start: async () => {
      // subscribe BEFORE the initial drain: an event landing between the drain's read and a
      // later subscribe would fall below the subscription's start cursor and never arrive —
      // this order guarantees every event is covered by the drain or the live stream
      unsub = await log.subscribe({}, () => enqueueReconcile())
      await serialize(async () => {
        cursorCache = (await drainFrom(await surreal.getCursor())).cursor
        await rebuildVaultMemory(surreal, vaultDir) // boot-time heal: replace vault/memory/** from Surreal
      })
    },
    close: async () => { closed = true; if (unsub) { await unsub(); unsub = null } await applying },
    rebuild: async () => {
      await serialize(async () => {
        await surreal.clear()
        cursorCache = (await drainFrom(0)).cursor
        await rebuildVaultMemory(surreal, vaultDir)
      })
    },
    // one-shot drain from the persisted cursor (no clear, no subscription) — the CLI's
    // projection path. O(applied), not O(notes): the full vault reconcile stays on start/rebuild.
    catchUp: async () => {
      await serialize(async () => {
        const r = await drainFrom(await surreal.getCursor())
        cursorCache = r.cursor
        if (r.vaultChanged > 0) await refreshIndex()
      })
    },
  }
}
