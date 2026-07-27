import { errorMessage, EVENT_KIND, MemoryDeletedPayload, MemoryWrittenPayload, type EventKind, type EventRecord } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { deleteMemoryFile, writeMemoryFile } from './write-note'
import { rebuildVaultMemory, renderMemoryIndex } from './memory-index'

export interface MemoryProjector { start(): Promise<void>; close(): Promise<void>; rebuild(): Promise<void>; catchUp(): Promise<void> }

// Everything the projector drains. Typed EventKind[] (not left to infer the narrower literal
// union) so start()'s subscribe filter below can compare a live EventRecord's kind against it.
export const MEMORY_KINDS: EventKind[] = [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted, EVENT_KIND.memory_accessed]

// What "the read model is behind" means for HEALTH — derived from the drained set so a fourth
// kind is covered automatically, with the one exclusion stated rather than implied. An
// unprojected access leaves `hits` briefly stale; that is a lagging counter, not a knowledge
// graph an agent would read wrongly, and reporting it as degraded would cry wolf on every read.
export const KNOWLEDGE_KINDS = MEMORY_KINDS.filter(k => k !== EVENT_KIND.memory_accessed)

// The grouping spec's own scaling trigger, as a number something can actually compare against.
// ponytail: one warn line, no metric — enough to notice; wire it to a real timer if it ever fires.
const SLOW_REFRESH_MS = 1_000

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
  //
  // `force` skips the "did anything change" gate below. Stage 3 runs here, at the ONE place
  // start/catchUp/rebuild all funnel through, so no caller can forget it — but "ran through here"
  // and "must repartition" are different questions. start()/rebuild() pass force:true because they
  // are the boot-time heal: the corpus may already hold claims from before this feature shipped, or
  // from a run where refreshTopics kept failing, and that MUST get partitioned even though the
  // cursor is already at head and zero events drain. catchUp() and the live reconcile leave it
  // false: they run far more often than the corpus's claims actually change, and the point of this
  // gate is that a drain carrying no memory_written/memory_deleted (redundant catch-up, or — before
  // start()'s subscribe filter below — a task run's non-memory events) does no partition work at all.
  const drainFrom = async (fromSeq: number, opts: { force?: boolean } = {}): Promise<{ cursor: number; vaultChanged: number }> => {
    const events = await log.after(fromSeq, MEMORY_KINDS)
    let vaultChanged = 0
    // finally, not a straight-line call: applyOne can throw AFTER an event's Surreal side committed
    // (the vault write is outside the transaction), and the retry then drains zero events and sees
    // vaultChanged 0 — so without this the topic table stays stale until the next memory write or a
    // restart, for claims that are already in the read model.
    try {
      for (const e of events) if (await applyOne(e)) vaultChanged += 1
    } finally {
      // vaultChanged counts an ACCEPTED memory_written/memory_deleted — the only events that can
      // change which claims exist, so it is exactly "did this drain touch the claim set", not "did we
      // drain anything": memory_accessed applies (bumps a counter) but never changes claims, and is
      // deliberately excluded from vaultChanged for that same reason (see applyOne above).
      if (vaultChanged > 0 || opts.force) {
        // Best-effort: a grouping failure must never fail a drain — the previous topic table stays
        // readable and the next drain retries.
        const started = Date.now()
        try {
          await surreal.refreshTopics()
        } catch (err) {
          console.warn(`[memory] topic refresh failed: ${errorMessage(err)}`)
        }
        // The partition is O(n^2) cosines over the whole project corpus and it runs on interactive
        // paths (catchUp is awaited by CLI commands), so the grouping spec's scaling trigger is a
        // wall-clock one. Measuring it is what makes that trigger fire-able instead of theoretical.
        const elapsed = Date.now() - started
        if (elapsed > SLOW_REFRESH_MS)
          console.warn(`[memory] topic refresh took ${elapsed}ms — past ${SLOW_REFRESH_MS}ms the claim corpus has outgrown the whole-corpus repartition; see cluster.ts's revisit trigger`)
      }
    }
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
    // auth-shaped errors heal the same way: the connect-option auth provider re-authenticates
    // on the driver's session renewal, so the retry lands on a fresh authenticated session
    /connect|connection|socket|websocket|transaction not found|anonymous access|not enough permissions/i.test(errorMessage(err))
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
          console.warn(`memory projector: ${errorMessage(err)}`)
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
      //
      // Filtered here, in the handler, because log.subscribe itself takes only `fromSeq` — no kind
      // filter (packages/kernel/src/kernel.ts:439) — and wakes on EVERY event in the project, task
      // and operation events included. A long task run appends hundreds of those; without this check
      // each one would enqueue a reconcile that finds zero memory events and, before this fix,
      // repartitioned anyway. Checking `e.kind` here means a non-memory event never even reaches
      // enqueueReconcile, so it costs nothing beyond the array membership test.
      unsub = await log.subscribe({}, e => { if (MEMORY_KINDS.includes(e.kind)) enqueueReconcile() })
      await serialize(async () => {
        // force: true — boot-time heal. The corpus may hold claims from before this feature
        // shipped, or from a run where refreshTopics kept failing; those must get partitioned even
        // though the cursor is already at head and drainFrom applies zero events. A plain "did we
        // drain anything" check cannot tell that case apart from "nothing to do" — that is exactly
        // why force is a separate, explicit signal rather than derived from the drain's own result.
        cursorCache = (await drainFrom(await surreal.getCursor(), { force: true })).cursor
        await rebuildVaultMemory(surreal, vaultDir) // boot-time heal: replace vault/memory/** from Surreal
      })
    },
    close: async () => { closed = true; if (unsub) { await unsub(); unsub = null } await applying },
    rebuild: async () => {
      await serialize(async () => {
        await surreal.clear()
        cursorCache = (await drainFrom(0, { force: true })).cursor // same boot-time-heal reasoning as start()
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
