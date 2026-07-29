import { frontmatter } from '@orc/vault-projector'
import { LINK_KIND, MemoryScope, type MemoryLink, type MemoryNote, type NoteView } from '@orc/contracts'

export function noteRelPath(note: Pick<MemoryNote, 'id' | 'scope'>): string {
  return note.scope === MemoryScope.project ? `${note.id}.md` : `${note.scope}/${note.id}.md`
}

// Exported because the vault is a read surface others assert against: a test spelling the heading
// out again could drift from what the renderer emits and still pass.
export const CLAIMS_HEADING = '## Claims'

// decomposes_into/depends_on links as navigable body links — other link kinds stay frontmatter-only
const linksOf = (links: MemoryLink[], kind: MemoryLink['kind']): string =>
  links.filter(l => l.kind === kind).map(l => `- [${l.id}](./${l.id}.md)`).join('\n')

// One shared frontmatter builder across the vault (block-style YAML — see frontmatter.ts).
// The note is read through NoteView so one renderer covers every tier: a field the note's tier
// does not have reads as undefined, and is spread away rather than written out as a hollow key —
// the vault file then shows the note's real shape, not a union's worth of empty fields.
export function renderNoteFile(note: MemoryNote): string {
  const n: NoteView = note
  const head = frontmatter({
    type: 'memory',
    id: note.id, scope: note.scope, title: note.title, tier: note.tier,
    ...(n.kind !== undefined && { kind: n.kind }),
    retention: note.retention, sourceRevision: note.sourceRevision,
    ...(n.categories !== undefined && { categories: n.categories }),
    tags: note.tags, links: note.links,
    ...(n.paths !== undefined && { paths: n.paths }),
    // the plan tier's execution payload — structured refs like paths/links, so frontmatter, not
    // prose. Empty defaults are omitted (every plan note has all four): a hollow `modelRef: ""` on
    // every subplan would drown the one that actually pinned a model.
    ...(n.dependsOn?.length ? { dependsOn: n.dependsOn } : {}),
    ...(n.skillRefs?.length ? { skillRefs: n.skillRefs } : {}),
    ...(n.toolRefs?.length ? { toolRefs: n.toolRefs } : {}),
    ...(n.modelRef ? { modelRef: n.modelRef } : {}),
    summary: note.summary,
    createdAt: note.createdAt, createdBy: note.createdBy,
    updatedAt: note.updatedAt, updatedBy: note.updatedBy, revision: note.revision,
  })
  const decomposesInto = linksOf(note.links, LINK_KIND.decomposes_into)
  const dependsOn = linksOf(note.links, LINK_KIND.depends_on)
  // citations render in the body, not frontmatter: they are for the human reading the note, and
  // retrievedAt is what makes a stale finding visible as stale
  const sources = (n.sources ?? [])
    .map(s => `- [${s.title ?? s.url}](${s.url}) — retrieved ${s.retrievedAt}`)
    .join('\n')
  // Claims render in the body, not frontmatter: a statement runs to a sentence, and block-style
  // YAML for a list of three-key objects buries the text a reader came for. The leading [id] is
  // load-bearing — it is the handle `invalidates` takes, so it has to be readable off the file.
  const claims = (n.claims ?? []).map(c => `- [${c.id}] ${c.text}`).join('\n')
  const sections = [
    claims ? `${CLAIMS_HEADING}\n\n${claims}` : '',
    n.rationale ? `## Rationale\n\n${n.rationale}` : '',
    n.uncertainty?.length ? `## Uncertainty\n\n${n.uncertainty.map(u => `- ${u}`).join('\n')}` : '',
    decomposesInto ? `## Decomposes into\n\n${decomposesInto}` : '',
    dependsOn ? `## Depends on\n\n${dependsOn}` : '',
    sources ? `## Sources\n\n${sources}` : '',
  ].filter(Boolean)
  return `${head}\n${note.body}${sections.length ? `\n\n${sections.join('\n\n')}` : ''}\n`
}
