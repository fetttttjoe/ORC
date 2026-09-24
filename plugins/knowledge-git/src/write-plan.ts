import {
  KNOWLEDGE_REFUSAL, KnowledgeClaim,
  type KnowledgeAddition, type KnowledgeAnchor, type KnowledgeDraft, type KnowledgePatch,
} from '@orc/contracts'
import { mergeChange, sameContent } from '@orc/knowledge-core'
import type { CheckoutSnapshot } from './checkout-index'
import { freshIdSource } from './fresh-ids'
import { bucketOf, type AnchorKind } from './layout'

export type KindOf = (anchorPath: string) => AnchorKind
export type NamedAddition = KnowledgeAddition & { id: string }
export interface Placement { snapshot: CheckoutSnapshot; kindOf: KindOf; dirName: string }

export interface Planned {
  added: KnowledgeClaim[]
  changed: Array<{ before: KnowledgeClaim; after: KnowledgeClaim }>
  retired: KnowledgeClaim[]
  affected: string[]
  warnings: string[]
}

export function nameAdditions(s: CheckoutSnapshot, patch: KnowledgePatch, newId: () => string): NamedAddition[] {
  const fresh = freshIdSource([...s.claims.keys(), ...patch.add.flatMap(a => a.id ?? []), ...patch.change.map(c => c.id), ...patch.retire], newId)
  return patch.add.map(a => ({ ...a, id: a.id ?? fresh() }))
}

export function generatedClash(s: CheckoutSnapshot, patch: KnowledgePatch, additions: readonly NamedAddition[]): boolean {
  const explicit = new Set(patch.add.flatMap(a => a.id ?? []))
  return additions.some(a => !explicit.has(a.id) && s.claims.has(a.id))
}

export const locationOf = (p: Placement, anchors: readonly KnowledgeAnchor[]): string =>
  bucketOf(anchors.map(a => p.kindOf(a.path))[0] ?? null, p.snapshot.packageRoots, p.dirName)

const single = (s: CheckoutSnapshot, id: string): KnowledgeClaim | undefined => {
  if (s.duplicates.has(id)) throw new Error(KNOWLEDGE_REFUSAL.duplicateId(id))
  return s.claims.get(id)
}

const place = (p: Placement, draft: KnowledgeDraft, id: string): KnowledgeClaim =>
  KnowledgeClaim.parse({ ...draft, id, location: locationOf(p, draft.anchors) })

export function planWrite(p: Placement, patch: KnowledgePatch, additions: readonly NamedAddition[]): Planned {
  const s = p.snapshot
  const added = additions.map(a => place(p, a, a.id))
  for (const claim of added) {
    const held = s.claims.get(claim.id)
    if (held && !sameContent(held, claim)) throw new Error(KNOWLEDGE_REFUSAL.idClash(claim.id))
  }
  const changed = patch.change.map(c => {
    const before = single(s, c.id)
    if (!before) throw new Error(KNOWLEDGE_REFUSAL.unknownId(c.id))
    return { before, after: place(p, mergeChange(before, c), c.id) }
  })
  const warnings: string[] = []
  const retired: KnowledgeClaim[] = []
  for (const id of patch.retire) {
    const held = single(s, id)
    if (held) retired.push(held)
    else warnings.push(KNOWLEDGE_REFUSAL.notRetired(id))
  }
  const affected = [...new Set([
    ...added.map(c => c.location),
    ...changed.flatMap(c => [c.before.location, c.after.location]),
    ...retired.map(c => c.location),
    ...added.flatMap(c => { const held = s.claims.get(c.id); return held ? [held.location] : [] }),
  ])].sort()
  return { added, changed, retired, affected, warnings }
}
