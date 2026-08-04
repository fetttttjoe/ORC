import { MEMORY_HEALTH, type EmbeddingProvider, type MemoryHealth, type MemoryStore } from '@orc/contracts'
import { errorMessage } from '@orc/contracts'
import { MemoryStage } from '@orc/contracts/health'
import { EventLog, type ProjectConfig } from '@orc/kernel'
import { openKnowledge, type Knowledge } from './knowledge'
import { createMemoryStore } from './store'
import { createMemoryProjector, KNOWLEDGE_KINDS, type MemoryProjector } from './projector'
import { bindStepMemory, unavailableStepMemory, type BindStep } from './step'
import { corpusDrift, createDriftProbe, type ChangedSince } from './drift'

// Only names something outside plugins/memory/src actually imports — everything else stays a
// module-internal export of its own file (a re-export nobody imports is API surface to keep
// compatible for no consumer; eighteen of them accumulated here before this was checked).
export { openKnowledge } from './knowledge'
// memoryVerifyTool is registered by the composition root (runtime.ts stepTools), not by
// bindStepMemory: the gate needs the STEP role and step id, which the per-step memory binding
// never sees — the same seam scoped_changes uses.
export { memoryTools, unavailableMemoryTools, memoryVerifyTool, MEMORY_READ_TOOLS, MEMORY_ROLE, memoryRoleFor } from './tools'
export { unavailableStepMemory, type BindStep } from './step'
export { orphanedNotes } from './sweep'
// the evidence-based lifecycle: recheck gathers the facts, archive rules on them (no clock in either)
export { recheckNotes, summarize } from './recheck'
export { archiveCandidates } from './archive'
export { frontier } from './frontier'
export { consolidateTask, type ConsolidationInput, type ConsolidationDistiller } from './consolidate'
export { createMemoryLifecycle, type MemoryLifecycle } from './lifecycle'
export { needsReground, restampableNotes, createDriftProbe } from './drift'
// consumer: packages/cli/src/runtime.ts, which binds it to the knowledge handle below and injects it
// into the step tools — the kernel never imports this plugin, so the query crosses as a callback.
export { notesCiting, type CitingNote } from './drift'
export { createGroundingSource } from './grounding-source'

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
export async function createMemory(opts: { log: EventLog; config: ProjectConfig; embedder?: EmbeddingProvider }): Promise<{
  store: MemoryStore
  projector: MemoryProjector
  bindStep: BindStep
  // The handle itself, not just the services built on it: the composition root has read queries to
  // wire that are NOT part of the store contract (notesCiting, injected into the step tools), and
  // with the handle closed over by close() alone it had nothing to pass them. Still owned here —
  // close() shuts it down, callers only read through it.
  knowledge: Knowledge
  close: () => Promise<void>
}> {
  const knowledge = await openKnowledge(opts.config, opts.embedder)
  const store = createMemoryStore({ log: opts.log, surreal: knowledge, sourceRevision: () => gitRevision(opts.config.dir), halfLifeDays: opts.config.memoryHalfLifeDays })
  const projector = createMemoryProjector({ log: opts.log, surreal: knowledge, vaultDir: opts.config.vaultDir })
  const changedSince = createDriftProbe(opts.config.dir)
  return {
    store, projector, knowledge,
    bindStep: p => bindStepMemory({ ...p, store, changedSince, catchUp: projector.catchUp }),
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
  changedSince: ChangedSince,
  knowledge: Pick<Knowledge, 'allNotes'>,
): Promise<MemoryHealth['drift']> {
  try {
    // Handed to corpusDrift WHOLE, no re-mapping. A stored note already satisfies what the check
    // reads — `paths` is optional there because only the semantic tier declares any — and the map
    // that used to narrow it here silently dropped `verified` the moment the stamp shipped: the
    // either-clean rule kept passing its own tests while no production caller could reach it.
    // Narrowing a shape by hand at a call site is how a new field goes missing; do not restore it.
    const d = await corpusDrift(await knowledge.allNotes(), changedSince)
    if (d.ratio === null) return undefined
    return { checkable: d.checkable, drifted: d.drifted, ratio: d.ratio }
  } catch {
    return undefined
  }
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
    const cursor = await knowledge.getCursor()
    const pending = await log.countAfter(cursor, KNOWLEDGE_KINDS)
    // Two different lags: `pending` is the read model behind the LOG (orc's own, self-healing);
    // drift is the corpus behind the CODE, which orc cannot fix alone.
    const drift = await measureDrift(createDriftProbe(config.dir), knowledge)
    // What the projector is doing RIGHT NOW, published by it into a shared meta row. `pending`
    // only covers the event replay; the linking and clustering stages run with pending already at
    // zero, which is why a boot could sit in ollama for minutes with nothing on screen to say so.
    // Written by the projector in ANOTHER process, so it is parsed at the door: an unrecognised or
    // half-written row yields no stage rather than an unknown label reaching the UI.
    const published = MemoryStage.safeParse(await knowledge.getStage().catch(() => null))
    const stage = published.success && livePid !== undefined && published.data.pid === livePid
      ? { name: published.data.name, sinceMs: Math.max(0, Date.now() - published.data.startedAt) }
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
