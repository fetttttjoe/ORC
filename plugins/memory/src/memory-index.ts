import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { NOTE_KIND, type MemoryNote, type NoteKind } from '@orc/contracts'
import { frontmatter, mermaidLabel } from '@orc/vault-projector'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { writeMemoryFile } from './write-note'

// Exported so a test can assert every NOTE_KINDS member is placed: a kind missing here still
// gets its note file, but never appears in the index, and nothing errors — which is exactly how
// `research` was invisible on arrival. `plan` stays deliberately unplaced (see that test).
// Research is its own section rather than folded into decisions/facts: a cited web finding is
// provisional and sweepable, and presenting it next to a decision would overstate it.
export const SECTIONS: { title: string; kinds: NoteKind[] }[] = [
  { title: 'Current architecture', kinds: [NOTE_KIND.architecture_current] },
  { title: 'Target architecture', kinds: [NOTE_KIND.architecture_target] },
  { title: 'Decisions and facts', kinds: [NOTE_KIND.decision, NOTE_KIND.fact, NOTE_KIND.documentation] },
  { title: 'Research', kinds: [NOTE_KIND.research] },
]

// ONE graph, sections as subgraphs — not one graph per section. Per-section graphs could only
// draw an edge whose endpoints shared a section, so every cross-kind link rendered nowhere while
// memory_neighbors traversed it perfectly. Observed on a real run: an agent summarised a
// `research` note and linked `derived_from` to it, and that edge — the most informative one in a
// sourced-research workflow, since it is what ties a conclusion to its evidence — was invisible
// in the index. Node ids are assigned across the whole note set for the same reason: per-section
// numbering restarted at n0 and collided once the subgraphs shared a graph.
function subgraph(title: string, notes: MemoryNote[], node: Map<string, string>): string[] {
  if (notes.length === 0) return []
  const lines = [`  subgraph ${title.replaceAll(' ', '_')}["${title}"]`]
  for (const n of notes) {
    const name = node.get(`${n.scope}:${n.id}`)
    lines.push(`    ${name}["${mermaidLabel(n.title)}"]`)
  }
  lines.push('  end')
  return lines
}

// pure and deterministic: same notes → byte-identical markdown
export function renderMemoryIndex(notes: MemoryNote[]): string {
  const placed = SECTIONS.map(s => ({ ...s, notes: notes.filter(n => s.kinds.includes(n.kind)) }))
  const shown = placed.flatMap(s => s.notes)
  const node = new Map(shown.map((n, i) => [`${n.scope}:${n.id}`, `n${i}`]))

  const lines = ['```mermaid', 'graph TD']
  for (const s of placed) lines.push(...subgraph(s.title, s.notes, node))
  // click bindings live outside the subgraphs: mermaid accepts them either way, and keeping them
  // together makes the node declarations readable.
  for (const n of shown) lines.push(`  click ${node.get(`${n.scope}:${n.id}`)} "${noteRelPath(n)}"`)
  // every edge whose BOTH endpoints are rendered, regardless of which sections they landed in
  for (const n of shown)
    for (const l of n.links) {
      const to = node.get(`${n.scope}:${l.id}`)
      if (to) lines.push(`  ${node.get(`${n.scope}:${n.id}`)} -->|${l.kind}| ${to}`)
    }
  lines.push('```')

  // Empty sections stay named rather than silently dropped: "no current architecture is
  // documented" is a fact about the project, and an absent heading reads as "not a category
  // here" instead of "nothing here yet".
  const empty = placed.filter(s => s.notes.length === 0).map(s => s.title)
  const body = [
    shown.length === 0 ? '_none_' : lines.join('\n'),
    empty.length > 0 ? `_Not yet documented: ${empty.join(', ')}._` : '',
  ].filter(Boolean).join('\n\n')

  return `${frontmatter({ type: 'memory-index' })}\n# Knowledge\n\n${body}\n`
}

// Replace vault/memory/** from current Surreal state: manually deleted files reappear,
// stale files disappear, and index.md always reflects the live graph. Vault is never truth.
export async function rebuildVaultMemory(surreal: SurrealMemory, vaultDir: string): Promise<void> {
  const notes = await surreal.allNotes()
  const root = path.join(vaultDir, 'memory')
  const expected = new Set([...notes.map(n => noteRelPath(n)), 'index.md'])
  for (const rel of listFiles(root)) if (!expected.has(rel)) rmSync(path.join(root, rel), { force: true })
  for (const n of notes) writeMemoryFile(vaultDir, noteRelPath(n), renderNoteFile(n))
  writeMemoryFile(vaultDir, 'index.md', renderMemoryIndex(notes))
}

function listFiles(root: string): string[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.relative(root, path.join(e.parentPath, e.name)))
}
