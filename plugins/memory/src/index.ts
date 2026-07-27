import { MEMORY_HEALTH, type EmbeddingProvider, type MemoryHealth, type MemoryStore } from '@orc/contracts'
import { errorMessage } from '@orc/contracts'
import { EventLog, type ProjectConfig } from '@orc/kernel'
import { openKnowledge, type Knowledge } from './knowledge'
import { createMemoryStore } from './store'
import { createMemoryProjector, KNOWLEDGE_KINDS, type MemoryProjector } from './projector'
import { bindStepMemory, unavailableStepMemory, type BindStep } from './step'
import { corpusDrift, createDriftProbe } from './drift'

export { SurrealMemory } from './surreal'
export { openKnowledge, type Knowledge } from './knowledge'
export { createMemoryStore } from './store'
export { createMemoryProjector } from './projector'
export { memoryTools, unavailableMemoryTools, MEMORY_READ_TOOLS, MEMORY_ROLE, memoryRoleFor, type MemoryRole } from './tools'
export { bindStepMemory, unavailableStepMemory, ambientNoteId, ambientLinks, deriveQueryTerms, preloadQuery, type BindStep, type StepMemoryBinding } from './step'
export { renderMemoryIndex, rebuildVaultMemory } from './memory-index'
export { orphanedNotes, staleNotes, DEFAULT_SWEEP_DAYS, type SweptNote, type StaleNote } from './sweep'
export { consolidatedNote, consolidateTask, isSubstantive, CONSOLIDATED_TAG, type ConsolidationInput, type ConsolidationDeps, type ConsolidationDistiller, type DistilledText, type StepOutcome } from './consolidate'
export { createMemoryLifecycle, consolidateBacklog, taskCompletedId, type MemoryLifecycle } from './lifecycle'
export { renderNoteFile, noteRelPath } from './note-md'
export { noteHasDrifted, createDriftProbe, corpusDrift, needsReground, CORPUS_DRIFT_ADVISORY, type ChangedSince, type NoteDrift, type CorpusDrift } from './drift'

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
  close: () => Promise<void>
}> {
  const knowledge = await openKnowledge(opts.config, opts.embedder)
  const store = createMemoryStore({ log: opts.log, surreal: knowledge, sourceRevision: () => gitRevision(opts.config.dir), halfLifeDays: opts.config.memoryHalfLifeDays })
  const projector = createMemoryProjector({ log: opts.log, surreal: knowledge, vaultDir: opts.config.vaultDir })
  const changedSince = createDriftProbe(opts.config.dir)
  return {
    store, projector,
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
async function measureDrift(config: ProjectConfig, knowledge: Knowledge): Promise<MemoryHealth['drift']> {
  try {
    const notes = await knowledge.allNotes()
    const d = await corpusDrift(
      notes.map(n => ({ sourceRevision: n.sourceRevision ?? null, paths: 'paths' in n && Array.isArray(n.paths) ? n.paths : [] })),
      createDriftProbe(config.dir),
    )
    if (d.ratio === null) return undefined
    return { checkable: d.checkable, drifted: d.drifted, ratio: d.ratio }
  } catch {
    return undefined
  }
}

// healthy = reachable AND caught up with the log's memory events
export async function probeMemory(config: ProjectConfig, log: EventLog): Promise<MemoryHealth> {
  let knowledge: Knowledge | undefined
  try {
    knowledge = await openKnowledge(config)
    const cursor = await knowledge.getCursor()
    const pending = await log.countAfter(cursor, KNOWLEDGE_KINDS)
    // Two different lags: `pending` is the read model behind the LOG (orc's own, self-healing);
    // drift is the corpus behind the CODE, which orc cannot fix alone.
    const drift = await measureDrift(config, knowledge)
    return pending === 0
      ? { state: MEMORY_HEALTH.ok, pending, ...(drift && { drift }) }
      : { state: MEMORY_HEALTH.catchingUp, pending, reason: `${pending} event(s) not yet projected`, ...(drift && { drift }) }
  } catch (err) {
    return { state: MEMORY_HEALTH.unreachable, pending: 0, reason: errorMessage(err) }
  } finally {
    // close even if getCursor/countAfter threw after a successful open (same leak class as open())
    await knowledge?.close().catch(() => {})
  }
}
