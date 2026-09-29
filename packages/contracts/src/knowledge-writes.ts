export interface WrittenRef { id: string; location: string }
export interface WrittenRefs { added: readonly WrittenRef[]; changed: readonly WrittenRef[]; retired: readonly WrittenRef[]; files: readonly string[] }
export interface KnowledgeWrites { live: WrittenRef[]; retired: WrittenRef[]; files: string[] }

export const NO_KNOWLEDGE_WRITES: KnowledgeWrites = { live: [], retired: [], files: [] }

export function foldKnowledgeWrites(writes: readonly WrittenRefs[]): KnowledgeWrites {
  const live = new Map<string, WrittenRef>()
  const retired = new Map<string, WrittenRef>()
  const files = new Set<string>()
  for (const w of writes) {
    for (const r of [...w.added, ...w.changed]) { live.set(r.id, { id: r.id, location: r.location }); retired.delete(r.id) }
    for (const r of w.retired) { live.delete(r.id); retired.set(r.id, { id: r.id, location: r.location }) }
    for (const f of w.files) files.add(f)
  }
  return { live: [...live.values()], retired: [...retired.values()], files: [...files].sort() }
}
