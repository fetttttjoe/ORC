import { MEMORY_HEALTH, type EmbeddingProvider, type MemoryAuthor, type MemoryHealth, type MemoryStore, type TreeStamps } from '@orc/contracts'
import { errorMessage } from '@orc/contracts'
import { MemoryStage } from '@orc/contracts/health'
import { EventLog, type ProjectConfig, type ProjectorLease } from '@orc/kernel'
import { openKnowledge, type Knowledge } from './knowledge'
import { createMemoryStore } from './store'
import { createMemoryProjector, KNOWLEDGE_KINDS, type MemoryProjector } from './projector'
import { checkoutDrift, readCorpusDrift, type DriftSources } from './claim-drift-read'
import { createWorkspaceView } from './workspace-view'
import { createDriftCache } from './drift-cache'
import { treeFingerprint } from '@orc/kernel'

// Only names something outside plugins/memory/src actually imports — everything else stays a
// module-internal export of its own file (a re-export nobody imports is API surface to keep
// compatible for no consumer; eighteen of them accumulated here before this was checked).
export { openKnowledge } from './knowledge'
export { memoryTools, MEMORY_READ_TOOLS, MEMORY_ROLE, DECISION_KIND_REFUSAL } from './tools'
export { orphanedNotes } from './sweep'
// the evidence-based lifecycle: recheck gathers the facts, archive rules on them (no clock in either)
export { recheckNotes, summarize, RECHECK_KINDS } from './recheck'
// The event kinds a KNOWLEDGE fold needs, exported because a caller that hand-lists them drops one:
// `orc memory recheck` spelled its own [written, deleted, accessed] and so never fetched
// memory_verified, which left every verification invisible to the recheck and the archive rules
// even after the fold learned to apply it.
export { KNOWLEDGE_KINDS } from './projector'
export { archiveCandidates } from './archive'
export { frontier } from './frontier'
export { needsReground, restampableNotes, createDriftProbe } from './drift'
// the ONE reader every drift surface goes through — per claim where a note has claims, per
// declared path where it does not
export { checkoutDrift, readCorpusDrift, readNoteDrift, type DriftSources } from './claim-drift-read'
// consumer: packages/cli/src/mcp-serve.ts, which builds its own read tools and so must bind this
// dep itself — the same reason it builds its own createDriftProbe rather than taking createMemory's.
// `provisionalOf` and the view TYPES stay module-internal: nothing outside this plugin derives the
// flag or names the shape, and a re-export nobody imports is API surface to keep compatible for no
// consumer (see this file's header).
export { createWorkspaceView } from './workspace-view'
// consumer: packages/cli/src/workspace-health.ts, which needs "how much knowledge is still pending
// in this checkout" to tell a dangling workspace from an idle one. It takes a PROBE, so a caller
// wires it up without naming the view's shape: createWorkspaceView above builds one from a log, and
// a caller that has already folded the log hands its own maps back instead — which is what the
// workspace lister does, since a second fold there would be a second read of the same log.
export { provisionalNoteCounts } from './provisional-count'
export { restampToHead } from './restamp'
// consumer: packages/cli/src/runtime.ts, which binds it to the knowledge handle below and injects it
// into the step tools — the kernel never imports this plugin, so the query crosses as a callback.
export { notesCiting, type CitingNote } from './drift'
export { createGroundingSource } from './grounding-source'
// consumers: packages/cli/src/runtime.ts and memory-open.ts, which key it by checkout directory
export { treeStamps } from './tree-stamps'

// assembles the knowledge service + event log into the memory store and its projector
export async function createMemory(opts: {
  log: EventLog
  config: ProjectConfig
  embedder?: EmbeddingProvider
  lease?: ProjectorLease
  // from the caller: only the composition root knows which checkout an author's workspace is
  stampsFor?: (author: MemoryAuthor) => TreeStamps
}): Promise<{
  store: MemoryStore
  projector: MemoryProjector
  // The handle itself, not just the services built on it: the composition root has read queries to
  // wire that are NOT part of the store contract (notesCiting, injected into the step tools), and
  // with the handle closed over by close() alone it had nothing to pass them. Still owned here —
  // close() shuts it down, callers only read through it.
  knowledge: Knowledge
  close: () => Promise<void>
}> {
  const knowledge = await openKnowledge(opts.config, opts.embedder)
  const store = createMemoryStore({ log: opts.log, surreal: knowledge, ...(opts.stampsFor && { stampsFor: opts.stampsFor }), halfLifeDays: opts.config.memoryHalfLifeDays })
  // from the log, not from a Kernel: this plugin holds no kernel
  const workspaceView = createWorkspaceView(opts.log)
  const projector = createMemoryProjector({ log: opts.log, surreal: knowledge, vaultDir: opts.config.vaultDir, workspaceView, ...(opts.lease && { lease: opts.lease }) })
  return {
    store, projector, knowledge,
    close: async () => { await projector.close(); await knowledge.close() },
  }
}

// Notes only — a claim carries its own sourceRevision but no declared paths, so the note is the unit
// that can be checked against the tree. One git diff per DISTINCT revision (createDriftProbe caches).
//
// NEVER THROWS. A drift reading is advisory, so every failure — no repo, unreadable tree, nothing
// checkable — returns undefined, which callers render as "not measured". That is deliberately
// distinct from a measured zero: absent means we do not know, zero would claim the graph is current.
// Takes only what it reads — the probe and a note source — so the measurement is testable without a
// Surreal connection or a repo on disk, the same narrowing `corpusDrift`/`needsReground` already
// commit to. The probe is built by the caller because `config.dir` is the caller's business.
export async function measureDrift(
  drift: DriftSources,
  knowledge: Pick<Knowledge, 'allNotes'>,
): Promise<MemoryHealth['drift']> {
  try {
    // Handed to corpusDrift WHOLE, no re-mapping. A stored note already satisfies what the check
    // reads — `paths` is optional there because only the semantic tier declares any — and the map
    // that used to narrow it here silently dropped `verified` the moment the stamp shipped: the
    // either-clean rule kept passing its own tests while no production caller could reach it.
    // Narrowing a shape by hand at a call site is how a new field goes missing; do not restore it.
    const d = await readCorpusDrift(await knowledge.allNotes(), drift)
    if (d.ratio === null) return undefined
    return { checkable: d.checkable, drifted: d.drifted, ratio: d.ratio }
  } catch {
    return undefined
  }
}

// One cache per project directory, so two projects probed from one process cannot serve each
// other's verdict. Module-scoped deliberately: the point is to outlive a single probe, which is
// where the previous per-call `createDriftProbe` lost every result it computed.
const driftCaches = new Map<string, ReturnType<typeof createDriftCache<MemoryHealth['drift']>>>()
const driftCacheFor = (dir: string): ReturnType<typeof createDriftCache<MemoryHealth['drift']>> => {
  const hit = driftCaches.get(dir)
  if (hit) return hit
  const made = createDriftCache<MemoryHealth['drift']>(() => treeFingerprint(dir))
  driftCaches.set(dir, made)
  return made
}

// healthy = reachable AND caught up with the log's memory events
/**
 * `livePid` is the supervisor currently driving, when there is one. The stage row is published by
 * the projector and cleared only by it, so a supervisor killed mid-refresh leaves one behind that
 * no reader can clear — observed live at 35 minutes stale, and shown again during the NEXT boot
 * because "booting" looked live. Matching on pid is exact where an age threshold would be a guess:
 * a stage belongs to one process, and any other process's stage is history.
 */
export async function probeMemory(config: ProjectConfig, log: EventLog, livePid?: number): Promise<MemoryHealth> {
  let knowledge: Knowledge | undefined
  try {
    knowledge = await openKnowledge(config)
    // captured so the deferred compute closure below reads the handle THIS probe opened, rather
    // than the outer `let` whose narrowing does not survive the closure
    const k = knowledge
    const cursor = await k.getCursor()
    const pending = await log.countAfter(cursor, KNOWLEDGE_KINDS)
    // Two different lags: `pending` is the read model behind the LOG (orc's own, self-healing);
    // drift is the corpus behind the CODE, which orc cannot fix alone.
    //
    // Cached on (cursor, tree fingerprint) because this sits on a POLLED path — the console's
    // banner asks every 3s. Exact invalidation, not a TTL: every way the verdict could change moves
    // one half of the key.
    //
    // MEASURED on a 112-note corpus, 2026-08-02: a full probe was 433-553ms, of which ~336ms was
    // per-revision `git diff` (13 distinct revisions) against ~10ms for the fingerprint. With the
    // cache: 553ms cold, 116-141ms warm.
    //
    // The remaining ~120ms is NOT drift — allNotes no longer runs on a hit. It is the Surreal
    // connection this function opens per probe (~68ms) plus its cursor/count queries. That is the
    // next lever if this path is ever hot again; it needs a connection whose lifetime outlives one
    // probe, which is a change to who owns the handle, not to this cache.
    const drift = await driftCacheFor(config.dir)(cursor, () => measureDrift(checkoutDrift(config.dir), k))
    // What the projector is doing RIGHT NOW, published by it into a shared meta row. `pending`
    // only covers the event replay; the linking and clustering stages run with pending already at
    // zero, which is why a boot could sit in ollama for minutes with nothing on screen to say so.
    // Written by the projector in ANOTHER process, so it is parsed at the door: an unrecognised or
    // half-written row yields no stage rather than an unknown label reaching the UI.
    const published = MemoryStage.safeParse(await knowledge.getStage().catch(() => null))
    const stage = published.success && livePid !== undefined && published.data.pid === livePid
      ? {
          name: published.data.name,
          sinceMs: Math.max(0, Date.now() - published.data.startedAt),
          // carried only when the publisher counted something — the replay does, the two
          // whole-corpus passes have no unit to count and omit it rather than invent a denominator
          ...(published.data.progress && { progress: published.data.progress }),
        }
      : undefined
    return pending === 0
      ? { state: MEMORY_HEALTH.ok, pending, ...(drift && { drift }), ...(stage && { stage }) }
      : { state: MEMORY_HEALTH.catchingUp, pending, reason: `${pending} event(s) not yet projected`, ...(drift && { drift }), ...(stage && { stage }) }
  } catch (err) {
    return { state: MEMORY_HEALTH.unreachable, pending: 0, reason: errorMessage(err) }
  } finally {
    // close even if getCursor/countAfter threw after a successful open (same leak class as open())
    await knowledge?.close().catch(() => {})
  }
}
