import { frontmatter } from '@orc/vault-projector'
import { LINK_KIND, type MemoryLink, type MemoryNote } from '@orc/contracts'

export function noteRelPath(note: Pick<MemoryNote, 'id' | 'scope'>): string {
  return note.scope === 'project' ? `${note.id}.md` : `${note.scope}/${note.id}.md`
}

// decomposes_into/depends_on links as navigable body links — other link kinds stay frontmatter-only
const linksOf = (links: MemoryLink[], kind: MemoryLink['kind']): string =>
  links.filter(l => l.kind === kind).map(l => `- [${l.id}](./${l.id}.md)`).join('\n')

// One shared frontmatter builder across the vault (block-style YAML — see frontmatter.ts).
export function renderNoteFile(note: MemoryNote): string {
  const head = frontmatter({
    type: 'memory',
    id: note.id, scope: note.scope, title: note.title,
    kind: note.kind, sourceRevision: note.sourceRevision,
    categories: note.categories, tags: note.tags, links: note.links,
    paths: note.paths, rules: note.rules, summary: note.summary,
    createdAt: note.createdAt, createdBy: note.createdBy,
    updatedAt: note.updatedAt, updatedBy: note.updatedBy, revision: note.revision,
  })
  const decomposesInto = linksOf(note.links, LINK_KIND.decomposes_into)
  const dependsOn = linksOf(note.links, LINK_KIND.depends_on)
  // citations render in the body, not frontmatter: they are for the human reading the note, and
  // retrievedAt is what makes a stale finding visible as stale
  const sources = note.sources
    .map(s => `- [${s.title ?? s.url}](${s.url}) — retrieved ${s.retrievedAt}`)
    .join('\n')
  const sections = [
    note.rationale ? `## Rationale\n\n${note.rationale}` : '',
    note.uncertainty.length ? `## Uncertainty\n\n${note.uncertainty.map(u => `- ${u}`).join('\n')}` : '',
    decomposesInto ? `## Decomposes into\n\n${decomposesInto}` : '',
    dependsOn ? `## Depends on\n\n${dependsOn}` : '',
    sources ? `## Sources\n\n${sources}` : '',
  ].filter(Boolean)
  return `${head}\n${note.body}${sections.length ? `\n\n${sections.join('\n\n')}` : ''}\n`
}
