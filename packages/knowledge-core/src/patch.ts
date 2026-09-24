import type { KnowledgeChange, KnowledgeClaim, KnowledgeDraft } from '@orc/contracts'

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
