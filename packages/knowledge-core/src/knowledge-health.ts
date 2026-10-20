import { ClaimState, errorMessage, KnowledgeHealthState, type KnowledgeAccess, type KnowledgeHealth, type Author } from '@orc/contracts'
import { driftCounts } from './drift-counts'

export async function knowledgeHealth(access: KnowledgeAccess, author: Author): Promise<KnowledgeHealth> {
  if ('unavailable' in access) return { state: KnowledgeHealthState.unavailable, reason: access.unavailable }
  try {
    const drifts = await access.port.drift({ author, idempotencyKey: null })
    return { state: KnowledgeHealthState.ok, claims: drifts.length, suspect: driftCounts(drifts)[ClaimState.suspect] }
  } catch (err) {
    return { state: KnowledgeHealthState.unavailable, reason: errorMessage(err) }
  }
}
