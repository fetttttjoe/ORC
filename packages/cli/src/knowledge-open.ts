import { KERNEL_ERROR_CODE, KernelError, type EventLog, type ProjectConfig } from '@orc/kernel'
import { errorMessage, KNOWLEDGE_REFUSAL, type EventKind, type KnowledgeAccess, type KnowledgeBackend, type KnowledgeHost, type KnowledgePlugin } from '@orc/contracts'
import { BASIS_EVIDENCE_KINDS, createEvidenceReader, createKnowledgePort, resolveKnowledgeBackend, type Evidence, type EvidenceReader, type EvidenceSource } from '@orc/knowledge-core'
import { gitFilesPlugin } from '@orc/knowledge-git'
import { createTreeSitterStructure } from '@orc/structure-treesitter'

export const NO_LOG_TO_APPEND = 'no event log is open, so nothing can be recorded'

export const KNOWLEDGE_PLUGINS: readonly KnowledgePlugin[] = [gitFilesPlugin]

const host: KnowledgeHost = { structure: createTreeSitterStructure() }

export type KnowledgeOpening = { backend: KnowledgeBackend } | { unavailable: string }

export function openKnowledge(config: Pick<ProjectConfig, 'knowledge'>): KnowledgeOpening {
  try {
    const backend = resolveKnowledgeBackend(config.knowledge, KNOWLEDGE_PLUGINS, host)
    return backend === null ? { unavailable: KNOWLEDGE_REFUSAL.off() } : { backend }
  } catch (err) {
    return { unavailable: errorMessage(err) }
  }
}

const readers = new WeakMap<object, EvidenceReader>()

type EvidenceLog = Pick<EventLog, 'after' | 'earliestSeq'>

const evidenceSource = (log: EvidenceLog): EvidenceSource => ({
  after: async (afterSeq, kinds) => (await log.after(afterSeq, [...kinds])).map(({ seq, kind, runToken, payload }) => ({ seq, kind, runToken, payload })),
  earliestSeq: () => log.earliestSeq(),
})

const readerFor = (log: EvidenceLog): EvidenceReader => {
  const held = readers.get(log)
  if (held !== undefined) return held
  const made = createEvidenceReader(evidenceSource(log), BASIS_EVIDENCE_KINDS)
  readers.set(log, made)
  return made
}

export function knowledgeAccess(
  opening: KnowledgeOpening, log: EvidenceLog & Pick<EventLog, 'append'>, checkout: string, evidence: () => Promise<Evidence> = () => readerFor(log).read(),
): KnowledgeAccess {
  if ('unavailable' in opening) return opening
  return {
    port: createKnowledgePort({
      backend: opening.backend,
      checkoutOf: async () => checkout,
      append: async event => {
        try { await log.append(event) } catch (err) {
          if (!(err instanceof KernelError && err.code === KERNEL_ERROR_CODE.idempotency_conflict)) throw err
        }
      },
      evidence,
    }),
  }
}

export function knowledgeAccessWithoutEvidence(opening: KnowledgeOpening, checkout: string): KnowledgeAccess {
  if ('unavailable' in opening) return opening
  return {
    port: createKnowledgePort({
      backend: opening.backend,
      checkoutOf: async () => checkout,
      append: async () => { throw new Error(NO_LOG_TO_APPEND) },
    }),
  }
}

export function evidenceOnce(log: EvidenceLog, kinds: readonly EventKind[]): () => Promise<Evidence> {
  const reader = createEvidenceReader(evidenceSource(log), kinds)
  let held: Promise<Evidence> | null = null
  return () => (held ??= reader.read())
}
