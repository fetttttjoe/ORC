import { frontmatter } from '@orc/vault-projector'
import { LINK_KIND, MemoryScope, type MemoryLink, type MemoryNote, type NoteView } from '@orc/contracts'
import { provisionalOf, type WorkspaceView } from './provisional'

export function noteRelPath(note: Pick<MemoryNote, 'id' | 'scope'>): string {
  return note.scope === MemoryScope.project ? `${note.id}.md` : `${note.scope}/${note.id}.md`
}

// Exported because the vault is a read surface others assert against: a test spelling the heading
// out again could drift from what the renderer emits and still pass.
export const CLAIMS_HEADING = '## Claims'

// decomposes_into/depends_on links as navigable body links — other link kinds stay frontmatter-only
const linksOf = (links: MemoryLink[], kind: MemoryLink['kind']): string =>
  links.filter(l => l.kind === kind).map(l => `- [${l.id}](./${l.id}.md)`).join('\n')

// Every NoteView key this renderer puts somewhere in the vault file (frontmatter or a body
// section) — the same guard budget.ts's FitterCoversNote applies to the read cap, applied here to
// the other hand-enumerated NoteView serialization: a field added to a tier but forgotten in this
// list is a compile error rather than a vault file that quietly omits it. `zone` is the one
// exclusion (mirrors ProjectionCoversTiers' `'id'`): it is freeze-time write-fence input the
// executor enforces off the projected note table directly (surreal.ts's toNote), never a
// human-facing field — the vault projection has never rendered it.
type RenderedField =
  | 'id' | 'scope' | 'title' | 'tier'                                  // frontmatter identity
  | 'kind' | 'categories'                                              // semantic tier, spread when present
  | 'retention' | 'sourceRevision'                                     // frontmatter provenance
  | 'tags' | 'links'                                                   // frontmatter + the body link sections
  | 'paths'                                                            // spread when present
  | 'dependsOn' | 'skillRefs' | 'toolRefs' | 'modelRef'                // plan tier's execution payload
  | 'summary'
  | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'revision' | 'verified'
  // rendered as the DERIVED `provisional` key rather than verbatim: a bare workspace uuid on every
  // file tells a reader nothing, where "this is pending in <that checkout>" is actionable
  | 'workspaceId'
  | 'sources' | 'claims' | 'rationale' | 'uncertainty'                 // body sections
  | 'body'
// `archived` is unrenderable by construction: an archived note's vault file is DELETED, so there
// is never a document to carry the flag. Excluded like `zone` rather than rendered as `false`.
type RenderCoversNote = Exclude<keyof NoteView, RenderedField | 'zone' | 'archived'> extends never ? true : never
const renderCoversNote: RenderCoversNote = true
void renderCoversNote

// One shared frontmatter builder across the vault (block-style YAML — see frontmatter.ts).
// The note is read through NoteView so one renderer covers every tier: a field the note's tier
// does not have reads as undefined, and is spread away rather than written out as a hollow key —
// the vault file then shows the note's real shape, not a union's worth of empty fields.
// `view` is the workspace standing at render time — the SAME derivation the read tools run, so the
// vault and the tools cannot disagree about one note. A SNAPSHOT, not the async probe the tools
// take: a render loop covers hundreds of notes and must fold the workspace table once, not per file.
// Absent = claim nothing, the same fail-toward-silence rule the drift probe follows.
//
// CEILING: the flag is stamped when the FILE is written, and `workspace_merged` re-renders nothing —
// so a merged workspace's files keep saying `provisional` until the notes are next written or the
// vault is replaced from Surreal (rebuildVaultMemory, which runs on projector start and on
// `orc memory rebuild`). The tools are always current because they derive per call; only the file is
// a snapshot. Upgrade path if that gap bites: have the memory projector wake on `workspace_merged`
// and re-render the notes carrying that workspaceId, which is a query it can already make.
export function renderNoteFile(note: MemoryNote, view?: WorkspaceView): string {
  const n: NoteView = note
  const provisional = view ? provisionalOf(note, view.workspaces, view.merged) : null
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
    // Omitted on the notes nobody has checked, which is most of them: a `verified: null` on every
    // file would read as a claim about them ("checked, found nothing") rather than as silence.
    ...(n.verified && { verified: n.verified }),
    // The workspace id alone, not the pair the tools return: a human reading the vault follows the
    // id to `orc ws`, where the title already lives, and a two-key block on every pending note would
    // outweigh the frontmatter it sits in. Omitted on trunk knowledge — same silence rule as above.
    ...(provisional && { provisional: provisional.workspaceId }),
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
