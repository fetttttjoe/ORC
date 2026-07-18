import { frontmatter } from '@orc/vault-projector'
import type { MemoryNote } from '@orc/contracts'

export function noteRelPath(note: Pick<MemoryNote, 'id' | 'scope'>): string {
  return note.scope === 'project' ? `${note.id}.md` : `${note.scope}/${note.id}.md`
}

// One shared frontmatter builder across the vault (block-style YAML — see frontmatter.ts).
export function renderNoteFile(note: MemoryNote): string {
  return `${frontmatter({
    type: 'memory',
    id: note.id, scope: note.scope, title: note.title,
    categories: note.categories, tags: note.tags, links: note.links,
    paths: note.paths, rules: note.rules, summary: note.summary,
    createdAt: note.createdAt, createdBy: note.createdBy,
    updatedAt: note.updatedAt, updatedBy: note.updatedBy, revision: note.revision,
  })}\n${note.body}\n`
}
