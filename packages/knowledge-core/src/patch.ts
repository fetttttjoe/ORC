import { KNOWLEDGE_REFUSAL, type KnowledgeChange, type KnowledgeClaim, type KnowledgeDraft, type KnowledgePatch } from '@orc/contracts'

export const mergeChange = (held: KnowledgeClaim, change: KnowledgeChange): KnowledgeDraft => ({
  text: change.text ?? held.text,
  class: change.class ?? held.class,
  anchors: change.anchors ?? held.anchors,
  tags: change.tags ?? held.tags,
  sources: change.sources ?? held.sources,
  decision: change.decision === undefined ? held.decision : change.decision,
})

const contentOf = (d: KnowledgeDraft): string => JSON.stringify([d.text, d.class, d.anchors, [...d.tags].sort(), d.sources, d.decision])
export const sameContent = (a: KnowledgeDraft, b: KnowledgeDraft): boolean => contentOf(a) === contentOf(b)

export function refuseUnknownDecision(patch: KnowledgePatch, known: () => ReadonlyMap<string, unknown>): void {
  const named = [patch.decision, ...patch.add.map(a => a.decision), ...patch.change.map(c => c.decision)].flatMap(slug => slug ?? [])
  if (named.length === 0) return
  const served = known()
  const unknown = named.find(slug => !served.has(slug))
  if (unknown !== undefined) throw new Error(KNOWLEDGE_REFUSAL.unknownDecision(unknown))
}
