import { ClaimState, KNOWLEDGE_LIMITS, type KnowledgePort, type KnowledgeRef, type Author } from '@orc/contracts'
import type { SuspectAt } from '@orc/kernel'

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export function suspectAtFor(access: { port: Pick<KnowledgePort, 'drift'> } | { unavailable: string }, author: Author): SuspectAt | undefined {
  if ('unavailable' in access) return undefined
  const { port } = access
  return async paths => {
    const refs = new Map<string, KnowledgeRef>()
    for (const batch of chunks(paths, KNOWLEDGE_LIMITS.patchItems))
      for (const d of await port.drift({ author, idempotencyKey: null }, { paths: batch }))
        if (d.state === ClaimState.suspect) refs.set(d.claim.id, { id: d.claim.id, location: d.claim.location })
    return [...refs.values()]
  }
}
