import { errorMessage, EVENT_KIND, foldMemory, MemoryDeletedPayload, MemoryVerifiedPayload, MemoryWrittenPayload, noteKey, type EventKind, type EventRecord } from '@orc/contracts'
import { MEMORY_STAGE, type MemoryStageName, type StageProgress } from '@orc/contracts/health'
import type { EventLog, ProjectorLease } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { deleteMemoryFile, writeMemoryFile } from './write-note'
import { rebuildVaultMemory, renderMemoryIndex } from './memory-index'

// rebuild()'s per-id accounting result. A projection that silently drops a note (a skip, a
// dropped write, anything) must report DEGRADED, not a bare success — a count/ratio comparison
// would pass exactly when only a few notes vanish, which is the failure mode this exists to
// close. `missing` names the exact note keys (`noteKey(scope, id)`) the log's fold says are live
// but that never landed in Surreal after replay, so a caller can act on the specific ids, not
// just "something is missing".
export interface RebuildResult { degraded: boolean; missing: string[] }

export interface MemoryProjector { start(): Promise<void>; close(): Promise<void>; rebuild(): Promise<RebuildResult>; catchUp(): Promise<void> }

// Everything the projector drains. Typed EventKind[] (not left to infer the narrower literal
// union) so start()'s subscribe filter below can compare a live EventRecord's kind against it.
export const MEMORY_KINDS: EventKind[] = [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted, EVENT_KIND.memory_accessed, EVENT_KIND.memory_verified, EVENT_KIND.memory_outcome]

// What "the read model is behind" means for HEALTH — derived from the drained set so a new
// kind is covered automatically, with the exclusions stated rather than implied. An unprojected
// access or use-outcome leaves a counter briefly stale; that is lagging bookkeeping, not a
// knowledge graph an agent would read wrongly, and reporting it as degraded would cry wolf on
// every read.
export const KNOWLEDGE_KINDS = MEMORY_KINDS.filter(k => k !== EVENT_KIND.memory_accessed && k !== EVENT_KIND.memory_outcome)

// The grouping spec's own scaling trigger, as a number something can actually compare against —
// split per STAGE, not one shared ceiling, because the two stages this warning used to cover
// (refreshLinks then refreshTopics) have unrelated cost shapes: refreshLinks is Surreal I/O (one
// RELATE round trip per note-link inside its transaction — see relateLinks in surreal.ts), while
// refreshTopics runs the pure, import-free partition() from cluster.ts plus its own delete+upsert
// transaction. A single `elapsed` spanning both, which is what shipped originally, cannot tell a
// reader which one to look at — that ambiguity is exactly what produced the mis-attributed "see
// cluster.ts" pointer this comment replaces (see area-topic-clustering / attribute-refresh-cost).
//
// ponytail: refreshLinks' ceiling is a placeholder — one warn line, no metric — until a workload
// with many note-links per note is actually measured. If it fires, the upgrade is batching
// relateLinks' per-link awaits (Surreal I/O), not anything in cluster.ts: this stage never touches
// a cosine.
const SLOW_LINK_REFRESH_MS = 1_000
// ponytail: one warn line, no metric — enough to notice; wire it to a real timer if it ever fires.
// This is the partition-COST ceiling: if it fires, the pre-registered upgrade is the claim-grouping
// spec's L1 cosine-matrix cache + L2 heap/Lance-Williams merge (both documented order-independence-
// preserving, byte-identical-output). It is NOT cluster.ts's HDBSCAN revisit trigger — that trigger
// fires on a different condition entirely (~1,000 claims AND visible mis-splitting, a quality
// signal) and is spelled out at cluster.ts's `partition` doc comment; a wall-clock stall here is a
// cost signal and does not by itself mean the ALGORITHM needs replacing.
const SLOW_TOPIC_REFRESH_MS = 1_000

// Progress for the BIG drain only. A wiped or long-idle read model replays hundreds of
// embed-bearing events through the configured embedder — measured 2026-08-01: ~376 memory_written
// events ≈ an hour on a CPU ollama — and the supervisor boot blocks on that drain with nothing on
// stdout, indistinguishable from a hang. One line per CATCHUP_REPORT_EVERY applied events says it
// is working; the CATCHUP_REPORT_MIN floor keeps routine drains (a task's handful of writes)
// silent so the line keeps meaning "this is a rebuild", not boot noise an operator learns to skip.
const CATCHUP_REPORT_MIN = 50
const CATCHUP_REPORT_EVERY = 25
/**
 * ONE rule for "is this drain worth narrating", shared by the stdout line and the published stage
 * so the console and the browser can never disagree about whether a rebuild is happening. A drain
 * under the floor is over in milliseconds; announcing it would make the browser flicker a stage on
 * every ordinary write, which is the same noise the floor was introduced to keep off stdout.
 */
export const isBigDrain = (total: number): boolean => total >= CATCHUP_REPORT_MIN
const isReportPoint = (applied: number, total: number): boolean =>
  isBigDrain(total) && applied % CATCHUP_REPORT_EVERY === 0
export const catchUpProgressLine = (applied: number, total: number): string | null =>
  isReportPoint(applied, total) ? `[memory] catch-up: ${applied}/${total} events projected` : null

// Coalesce the whole-corpus derivations on the LIVE path: a drain marks the model dirty and (re)arms
// a trailing timer instead of refreshing inline, so a burst — a grounded analyze that writes dozens
// — collapses to ONE refresh after activity settles, not one multi-second freeze per write. The
// interactive/boot paths (catchUp, start, rebuild) bypass it and refresh synchronously, because a CLI
// command that just drained expects fresh topics on return.
const DERIVED_REFRESH_DEBOUNCE_MS = 5_000
// The debounce is TRAILING, so it must be bounded: a sustained write stream (a note per step) would
// otherwise clear+re-arm the timer on every drain and starve refreshTopics / the delete-repair
// refreshLinks forever. This caps how long the coalesced refresh can be deferred from the FIRST
// still-unrefreshed write, so repartition/link-repair stays on a bounded cadence under load.
const DERIVED_REFRESH_MAX_WAIT_MS = 30_000

export function createMemoryProjector(opts: {
  log: EventLog
  surreal: SurrealMemory
  vaultDir: string
  // ONE live projector per project (see kernel's projectorLease). Absent = unconditional leader,
  // which is what one-shot CLI commands and tests want: they never start() the standing machinery.
  lease?: ProjectorLease
  // follower catch-up bound before the drain fallback — injectable so tests need not wait 5s
  followerWaitMs?: number
}): MemoryProjector {
  const { log, surreal, vaultDir } = opts
  let unsub: (() => Promise<void>) | null = null
  let applying: Promise<void> = Promise.resolve()
  // FOLLOWER: another process holds the projector lease and owns the standing machinery. This one
  // runs no subscription and no refresh loop; its catchUp waits on the holder's cursor instead.
  let follower = false

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
    // safeParse, matching surreal.applyEvent's own skip-and-advance for an unparseable payload.
    // A strict parse here re-threw on EXACTLY the events applyEvent had just decided to skip, and
    // applyEvent returns `true` for a skip (the cursor advanced), so the throw landed after the
    // Surreal commit: `orc memory rebuild` cleared the read model, replayed to that seq, threw, and
    // did it again on every retry — one unparseable event in an immutable log wedging the rebuild
    // permanently. The vault file is what is skipped here; the row is already projected.
    if (e.kind === EVENT_KIND.memory_written || e.kind === EVENT_KIND.memory_verified) {
      // Both re-render the file from the projected row, because both change what the frontmatter
      // says: a write changes the note, a verification stamps it. Re-rendering on the stamp is not
      // cosmetic — the vault is the human read surface, and a file that omits a verification the
      // read model holds is the two disagreeing about the same note.
      const parsed = (e.kind === EVENT_KIND.memory_written ? MemoryWrittenPayload.safeParse(e.payload) : MemoryVerifiedPayload.safeParse(e.payload))
      if (!parsed.success) return false
      const ref = 'note' in parsed.data ? parsed.data.note : parsed.data
      const full = await surreal.get(ref.id, ref.scope)
      // An archived note has no row (applyEvent deleted it), so `full` is null and its vault file
      // must go with it — the vault is the human read surface, and a file for a note the graph has
      // retired is the two disagreeing. A restore re-upserts the row and re-renders the file.
      if (full) writeMemoryFile(vaultDir, noteRelPath(full), renderNoteFile(full))
      else deleteMemoryFile(vaultDir, noteRelPath(ref))
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const parsed = MemoryDeletedPayload.safeParse(e.payload)
      if (!parsed.success) return false
      deleteMemoryFile(vaultDir, noteRelPath(parsed.data))
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
  // The PER-EVENT projection: apply the drained memory events to the read model. Always fast — each
  // note materializes its own claims and out-edges inside applyOne — and always on the hot path. It
  // runs NO whole-corpus derivation itself; on a drain that moved the claim set it hands off to the
  // caller's `reconcile` strategy (see refreshDerived / scheduleDerivedRefresh). `vaultChanged` counts
  // accepted memory_written/deleted (the only events that change which claims exist — memory_accessed
  // bumps a counter but never claims, so it is excluded); `deletedCount` is the subset that can
  // cascade edges away.
  const drainFrom = async (fromSeq: number, reconcile: (c: { deletedCount: number }) => void | Promise<void>, drainOpts: { announce?: boolean } = {}): Promise<{ cursor: number; vaultChanged: number; deletedCount: number }> => {
    const events = await log.after(fromSeq, MEMORY_KINDS)
    let vaultChanged = 0
    let deletedCount = 0
    // The replay is the boot's LONGEST stage and was the only one publishing nothing: `replaying`
    // sat in the contract unused while the browser showed a static "supervisor booting" through a
    // drain the stdout line was already narrating. Announced for a big drain (isBigDrain) — or
    // unconditionally when the CALLER says so: start/rebuild force it, because a small BOOT drain
    // that starves (three projectors contending, measured 18 minutes 2026-08-04) rendered as an
    // unchanging pulse precisely because nothing was published below the floor. Tracked in a local
    // flag rather than read back off the module `stage`, because the clear below must not wipe a
    // stage some OTHER path published — a live drain can overlap the debounced clustering refresh,
    // and clearing that would put the UI back to the lie this all replaced.
    const announce = drainOpts.announce === true || isBigDrain(events.length)
    // Below the floor a forced announce reports per EVENT (the stdout cadence would publish
    // nothing before the end): a boot showing 0/2 frozen for minutes is the honest signal.
    const perEvent = announce && !isBigDrain(events.length)
    const startedAt = Date.now()
    if (announce) publishStage({ name: MEMORY_STAGE.replaying, startedAt, progress: { applied: 0, total: events.length } })
    try {
      for (const [i, e] of events.entries()) {
        if (e.kind === EVENT_KIND.memory_written || e.kind === EVENT_KIND.memory_deleted) vaultChanged += 1
        if (e.kind === EVENT_KIND.memory_deleted) deletedCount += 1
        await applyOne(e)
        const progress = catchUpProgressLine(i + 1, events.length)
        if (progress) console.log(progress)
        if (progress || perEvent)
          publishStage({ name: MEMORY_STAGE.replaying, startedAt, progress: { applied: i + 1, total: events.length } })
      }
    } finally {
      // Cleared HERE, before reconcile, and only when this drain announced: refreshDerived publishes
      // its own stages immediately after, and a replay left standing would race them. A throw mid-
      // drain lands here too — a stage outliving its work is the failure the unconditional clear in
      // refreshDerived's finally already exists to prevent.
      if (announce) publishStage(null)
      // In a finally, not a straight-line call: applyOne can throw AFTER an event's Surreal side
      // committed (the vault write is outside the transaction), and the caller's retry then reads the
      // advanced cursor and drains zero events — so the reconcile of the claims ALREADY in the read
      // model has to happen here, on the drain that applied them, or the derived views stay stale
      // until the next write or a restart. `reconcile` is the caller's strategy — synchronous on the
      // interactive/boot paths, a debounced schedule on the live path — gated on the claim set moving.
      if (vaultChanged > 0) await reconcile({ deletedCount })
    }
    return { cursor: await surreal.getCursor(), vaultChanged, deletedCount }
  }

  // The WHOLE-CORPUS derivations, split OFF the per-event apply so callers can COALESCE them and keep
  // them off the hot path. Re-running BOTH on every single write used to freeze the supervisor's one
  // event loop — task admission included — for seconds each time, once the corpus grew.
  //
  //   * refreshLinks re-RELATEs every note's out-edges one-by-one: O(all notes) Surreal round trips.
  //     A plain WRITE already materialized its own edges in applyOne, so it does NOT need this. Only a
  //     DELETE does — Surreal drops a RELATE when either endpoint record is deleted, so a delete
  //     cascades away edges a NEIGHBOUR authored and never retracted, and only recomputing from the
  //     live note set restores them. Hence `hadDelete`: writes skip the global re-link entirely.
  //   * refreshTopics re-partitions the whole claim set — cluster.ts's partition() is O(n^2)–O(n^3)
  //     agglomerative clustering with no per-event shortcut, so it runs whenever the claim set moved.
  //
  // ponytail: partition() is the remaining ceiling — synchronous and superlinear, so ONE refresh can
  //   still stall the loop for seconds at a large corpus. The debounce below makes that RARE (one
  //   refresh per burst, not per write); if it still bites, the next step is a worker thread or
  //   incremental re-clustering — cluster.ts is a pure, import-free function precisely so it can move
  //   off-thread untouched. Each stage is timed separately so the slow-warning names WHICH stage.
  // What the projector is doing right now, published to a shared meta row because the health probe
  // runs in a DIFFERENT PROCESS (see surreal.setStage). The banner otherwise showed one static
  // sentence while ollama re-embedded the corpus for minutes. Advisory only.
  let stage: { name: MemoryStageName; startedAt: number } | null = null

  // Publishing is ADVISORY and must never fail the work it describes. `.catch()` alone was not
  // enough: it handles a rejected promise, but a surreal double missing the method throws
  // SYNCHRONOUSLY, past the catch, and took the whole refresh with it — twice. Going through
  // Promise.resolve().then turns either failure into the same rejection.
  const publishStage = (s: { name: MemoryStageName; startedAt: number; progress?: StageProgress } | null): void => {
    void Promise.resolve().then(() => surreal.setStage(s === null ? null : { ...s, pid: process.pid })).catch(() => {})
  }

  const refreshDerived = async (hadDelete: boolean): Promise<void> => {
    if (hadDelete) {
      const started = Date.now()
      stage = { name: MEMORY_STAGE.linking, startedAt: started }
      publishStage(stage)
      try { await surreal.refreshLinks() }
      catch (err) { console.warn(`[memory] link refresh failed: ${errorMessage(err)}`) }
      finally {
        const elapsed = Date.now() - started
        if (elapsed > SLOW_LINK_REFRESH_MS)
          console.warn(`[memory] link refresh took ${elapsed}ms — past ${SLOW_LINK_REFRESH_MS}ms; this stage is Surreal I/O (per-note-link RELATE round trips in refreshLinks), not clustering`)
      }
    }
    const started = Date.now()
    stage = { name: MEMORY_STAGE.clustering, startedAt: started }
    publishStage(stage)
    try { await surreal.refreshTopics() }
    catch (err) { console.warn(`[memory] topic refresh failed: ${errorMessage(err)}`) }
    finally {
      const elapsed = Date.now() - started
      if (elapsed > SLOW_TOPIC_REFRESH_MS)
        console.warn(`[memory] topic refresh took ${elapsed}ms — past ${SLOW_TOPIC_REFRESH_MS}ms; the claim corpus may have outgrown the whole-corpus repartition (cluster.ts's partition()) — see SLOW_TOPIC_REFRESH_MS's comment for the upgrade path`)
      // Idle again. UNCONDITIONAL and in the finally: a stage that outlives its work reports
      // activity that is not happening, and the banner then shows "clustering (101s so far)" at a
      // supervisor that has been ready for minutes — worse than showing nothing at all.
      stage = null
      publishStage(null)
    }
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
  // Live-path coalescing: state + a trailing debounce that runs the whole-corpus refresh ONCE after
  // writes settle. `pendingDelete` accumulates across the window so the coalesced refresh still
  // re-links if ANY drain in it deleted a note. Serialized with drains so it never reads a
  // half-applied state, and it folds in refreshIndex so the vault index coalesces too.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let pendingDelete = false
  let firstDirtyAt: number | null = null // when the current un-refreshed window opened, for the max-wait cap
  const scheduleDerivedRefresh = (hadDelete: boolean): void => {
    pendingDelete = pendingDelete || hadDelete
    if (firstDirtyAt === null) firstDirtyAt = Date.now()
    if (refreshTimer) clearTimeout(refreshTimer)
    // trailing debounce, bounded: the wait shrinks as the window ages, so the coalesced refresh fires
    // by DERIVED_REFRESH_MAX_WAIT_MS after the first still-unrefreshed write at the latest — a steady
    // write stream can defer it but never starve it.
    const wait = Math.max(0, Math.min(DERIVED_REFRESH_DEBOUNCE_MS, DERIVED_REFRESH_MAX_WAIT_MS - (Date.now() - firstDirtyAt)))
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      firstDirtyAt = null
      const del = pendingDelete
      pendingDelete = false
      void serialize(async () => { await refreshIndex(); await refreshDerived(del) })
    }, wait)
  }

  const enqueueReconcile = (): void => {
    void serialize(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          // reconcile arms the debounce (via scheduleDerivedRefresh) INSIDE drainFrom's finally, so a
          // burst coalesces to one refresh and a partial-apply throw still schedules what landed.
          cursorCache = (await drainFrom(cursorCache, c => scheduleDerivedRefresh(c.deletedCount > 0))).cursor
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

  // A follower does not project — it waits for the LEASE HOLDER's projection to cover the log,
  // which keeps read-your-writes without a second refresh loop. Bounded: a dead or wedged holder
  // must not hang every read forever, so on timeout this drains once itself. Safe to race a
  // slow-but-live holder: applyEvent is cursor-gated and idempotent, so the overlap costs
  // duplicate work, never a wrong row.
  const followerWaitMs = opts.followerWaitMs ?? 5_000
  const followerCatchUp = async (): Promise<void> => {
    const deadline = Date.now() + followerWaitMs
    for (;;) {
      if ((await log.after(await surreal.getCursor(), MEMORY_KINDS)).length === 0) return
      if (Date.now() >= deadline) break
      await new Promise(r => setTimeout(r, 200))
    }
    console.warn(`[memory] projector lease holder has not covered the log in ${followerWaitMs}ms — draining once in this process`)
    await serialize(async () => {
      cursorCache = (await drainFrom(await surreal.getCursor(), async c => { await refreshIndex(); await refreshDerived(c.deletedCount > 0) })).cursor
    })
  }

  return {
    start: async () => {
      // ONE live projector per project: the lease decides whether THIS process runs the standing
      // machinery (subscription, debounced whole-corpus refreshes, boot heal) or follows the
      // holder. Three processes each running the full loop against one SurrealDB starved a
      // supervisor boot's drain for 18 minutes — the read model has one writer; its refresh
      // machinery now has one owner too.
      if (opts.lease && !(await opts.lease.tryAcquire())) {
        follower = true
        console.log("[memory] projector lease held by another process — following (reads wait on the holder's cursor)")
        return
      }
      // A leftover stage from a process that DIED mid-refresh. The finally-clear covers a throw but
      // not a kill, so a supervisor killed while clustering leaves the row set and the banner then
      // reports work nobody is doing — observed live at 30 minutes stale. A projector that is only
      // now starting knows no refresh of its own is in flight, so clearing here is exact and needs
      // no staleness threshold to guess at.
      publishStage(null)
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
        // boot-time heal, done unconditionally (not gated on the drain's count): the corpus may hold
        // claims from before this feature shipped, or from a run where refreshTopics kept failing, so
        // topics must be partitioned even though the cursor is already at head and zero events drain;
        // and refreshDerived(true) rebuilds edges too, repairing any RELATE a delete cascaded away.
        cursorCache = (await drainFrom(await surreal.getCursor(), () => {}, { announce: true })).cursor
        await refreshDerived(true)
        await rebuildVaultMemory(surreal, vaultDir) // boot-time heal: replace vault/memory/** from Surreal
      })
    },
    close: async () => { closed = true; if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null } if (unsub) { await unsub(); unsub = null } await applying; await opts.lease?.release() },
    rebuild: async (): Promise<RebuildResult> =>
      serialize(async (): Promise<RebuildResult> => {
        // A follower clearing the read model would wipe rows under the lease holder's feet and
        // race its live drain over the rubble. One-shot CLI processes never start(), so they are
        // never followers — this only refuses a rebuild from a live secondary process.
        if (follower) throw new Error('the projector lease is held by another process — rebuild there, or stop it and retry')
        await surreal.clear()
        cursorCache = (await drainFrom(0, () => {}, { announce: true })).cursor
        await refreshDerived(true) // same boot-time-heal reasoning as start()
        await rebuildVaultMemory(surreal, vaultDir)

        // Per-id accounting: a rebuild that silently DROPS a note (a skip, a dropped write,
        // anything) must not report success. Scoped query (log.after with KNOWLEDGE_KINDS), never
        // log.all() — see MEMORY_KINDS/KNOWLEDGE_KINDS's own doc comment and the 'never scans the
        // whole log' test. `expected` is the fold's live note set (tombstones already excluded by
        // foldMemoryInto's delete-on-memory_deleted — same idiom as sweep.ts's liveNotes); `actual`
        // is what actually landed in Surreal after the replay above. The diff is a literal set
        // difference over ids, not a count/ratio — a ratio check passes exactly when only a FEW
        // notes vanish, the precise failure mode this exists to close.
        const events = await log.after(0, KNOWLEDGE_KINDS)
        const expected = foldMemory(events).notes.keys()
        const actual = new Set((await surreal.allNotes()).map(n => noteKey(n.scope, n.id)))
        const missing = [...expected].filter(k => !actual.has(k))
        const degraded = missing.length > 0
        if (degraded)
          console.warn(`[memory] rebuild missing ${missing.length} note(s) present in the log but absent from the read model: ${missing.join(', ')}`)
        return { degraded, missing }
      }),
    // one-shot drain from the persisted cursor (no clear, no subscription) — the CLI's
    // projection path. O(applied), not O(notes): the full vault reconcile stays on start/rebuild.
    catchUp: async () => {
      if (follower) return followerCatchUp()
      await serialize(async () => {
        // synchronous reconcile, NOT debounced: catchUp is the CLI's projection path, and a command
        // that awaits it (search, consolidate) expects fresh topics/edges on return, not 5s later.
        cursorCache = (await drainFrom(await surreal.getCursor(), async c => { await refreshIndex(); await refreshDerived(c.deletedCount > 0) })).cursor
      })
    },
  }
}
