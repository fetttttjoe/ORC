import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import { MemoryNoteInput } from '@orc/contracts'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { deleteMemoryFile, writeMemoryFile } from './write-note'

export interface MemoryProjector { start(): Promise<void>; close(): Promise<void>; rebuild(): Promise<void>; catchUp(): Promise<void> }

export function createMemoryProjector(opts: { log: EventLog; surreal: SurrealMemory; vaultDir: string }): MemoryProjector {
  const { log, surreal, vaultDir } = opts
  let unsub: (() => Promise<void>) | null = null
  let applying: Promise<void> = Promise.resolve()

  const applyOne = async (e: EventRecord): Promise<void> => {
    if (e.kind === EVENT_KIND.memory_written) {
      const p = e.payload as { note: unknown; author: any }
      const note = MemoryNoteInput.parse(p.note)
      await surreal.applyWritten({ seq: e.seq, ts: e.ts, note, author: p.author })
      const full = await surreal.get(note.id, note.scope)
      if (full) writeMemoryFile(vaultDir, noteRelPath(full), renderNoteFile(full))
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = e.payload as { id: string; scope: string; author: any }
      await surreal.applyDeleted({ seq: e.seq, ts: e.ts, id: p.id, scope: p.scope, author: p.author })
      deleteMemoryFile(vaultDir, noteRelPath({ id: p.id, scope: p.scope }))
    }
    await surreal.setCursor(e.seq)
  }

  // Serialize applies so revision/ordering is deterministic; reconcile by querying the log
  // WHERE seq > cursor rather than trusting the subscribe payload's ordering (the log's
  // subscribe cursor can skip a lower seq under concurrent non-tx appends — spec §4.3).
  const drainFrom = async (fromSeq: number): Promise<number> => {
    const events = (await log.all()).filter(e => e.seq > fromSeq && (e.kind === EVENT_KIND.memory_written || e.kind === EVENT_KIND.memory_deleted))
    for (const e of events) await applyOne(e)
    return surreal.getCursor()
  }

  let cursorCache = 0
  const enqueueReconcile = (): void => {
    applying = applying
      .then(async () => { cursorCache = await drainFrom(cursorCache) })
      .catch(err => console.warn(`memory projector: ${err instanceof Error ? err.message : String(err)}`))
  }

  return {
    start: async () => {
      cursorCache = await drainFrom(await surreal.getCursor())
      unsub = await log.subscribe({}, () => enqueueReconcile())
    },
    close: async () => { if (unsub) { await unsub(); unsub = null } await applying },
    rebuild: async () => { await surreal.clear(); cursorCache = await drainFrom(0) },
    // one-shot drain from the persisted cursor (no clear, no subscription) — the CLI's projection path
    catchUp: async () => { cursorCache = await drainFrom(await surreal.getCursor()) },
  }
}
