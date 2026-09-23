import { createOllamaEmbeddingProvider } from '@orc/provider-ollama'
import { errorMessage, parseModelRef, type EmbeddingProvider, type MemoryAuthor, type TreeStamps } from '@orc/contracts'
import { createMemory, treeStamps } from '@orc/memory'
import type { EventLog, ProjectConfig, ProjectorLease } from '@orc/kernel'

// Build the configured embedding provider (memoryEmbedModel), or undefined for keyword-only. The
// composition root owns this wiring so the memory plugin stays provider-agnostic behind the seam.
// ponytail: only ollama is wired; add openai/voyage/… branches as their EmbeddingProvider impls land.
export function buildEmbeddingProvider(
  config: Pick<ProjectConfig, 'memoryEmbedModel' | 'ollamaBaseUrl'>,
): EmbeddingProvider | undefined {
  const ref = config.memoryEmbedModel.trim()
  if (!ref) return undefined
  const { providerId, modelId } = parseModelRef(ref)
  if (providerId === 'ollama' && modelId)
    return createOllamaEmbeddingProvider({ model: modelId, baseUrl: config.ollamaBaseUrl })
  console.warn(`memoryEmbedModel '${ref}': no embedding provider for '${providerId}' — semantic search disabled (keyword only)`)
  return undefined
}

// createMemory with the configured embedder injected — the ONE construction path every CLI memory
// command and the runtime share, so semantic retrieval is on everywhere or nowhere by one setting.
// `lease`: passed by the RUNTIME path only (serve, graph, mcp — anything that projector.start()s),
// so one process owns the standing refresh machinery. One-shot commands never start() and need none.
export const openMemory = (opts: { log: EventLog; config: ProjectConfig; lease?: ProjectorLease; stampsFor?: (author: MemoryAuthor) => TreeStamps }) =>
  createMemory({
    log: opts.log, config: opts.config, embedder: buildEmbeddingProvider(opts.config),
    ...(opts.lease && { lease: opts.lease }),
    // a one-shot command writes from the directory it was typed in; the runtime hands a workspace-keyed provider
    stampsFor: opts.stampsFor ?? (() => treeStamps(opts.config.dir)),
  })

// The ONE open → work → close bracket every one-shot memory command and door runs through. The
// close is deliberately in a finally: seven commands (add, rm, sweep, ls, search, cat, rebuild)
// used to close only after a successful body, so any throw mid-body leaked the Surreal connection
// for the life of the process.
export async function withMemory<T>(
  opts: { log: EventLog; config: ProjectConfig },
  body: (memory: Awaited<ReturnType<typeof openMemory>>) => Promise<T>,
): Promise<T> {
  const memory = await openMemory(opts)
  try {
    return await body(memory)
  } finally {
    // REPORTED, never thrown: every write door through here (`orc memory add`, `orc adr new`,
    // OrcActions.writeNote/recordDecision/deleteNote) has already committed its event by now, so a
    // close that fails must not turn a successful write into a non-zero exit — the operator would
    // retry and meet a refusal for the note they were just told had failed. It cannot mask the
    // body's own failure either: a throw from the body still propagates out of this finally.
    await memory.close().catch((err: unknown) => console.warn(`memory connection not closed cleanly (${errorMessage(err)}) — the write itself is committed`))
  }
}
