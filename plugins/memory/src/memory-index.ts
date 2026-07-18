import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { NOTE_KIND, type MemoryNote, type NoteKind } from '@orc/contracts'
import { frontmatter, mermaidLabel } from '@orc/vault-projector'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { writeMemoryFile } from './write-note'

const SECTIONS: { title: string; kinds: NoteKind[] }[] = [
  { title: 'Current architecture', kinds: [NOTE_KIND.architecture_current] },
  { title: 'Target architecture', kinds: [NOTE_KIND.architecture_target] },
  { title: 'Decisions and facts', kinds: [NOTE_KIND.decision, NOTE_KIND.fact, NOTE_KIND.documentation] },
]

function section(title: string, notes: MemoryNote[]): string {
  if (notes.length === 0) return `## ${title}\n\n_none_`
  const node = new Map(notes.map((n, i) => [`${n.scope}:${n.id}`, `n${i}`]))
  const lines = ['```mermaid', 'graph TD']
  for (const n of notes) {
    const name = node.get(`${n.scope}:${n.id}`)
    lines.push(`  ${name}["${mermaidLabel(n.title)}"]`)
    lines.push(`  click ${name} "${noteRelPath(n)}"`)
  }
  for (const n of notes)
    for (const l of n.links) {
      const to = node.get(`${n.scope}:${l.id}`)
      if (to) lines.push(`  ${node.get(`${n.scope}:${n.id}`)} -->|${l.kind}| ${to}`)
    }
  lines.push('```')
  return `## ${title}\n\n${lines.join('\n')}`
}

// pure and deterministic: same notes → byte-identical markdown
export function renderMemoryIndex(notes: MemoryNote[]): string {
  const body = SECTIONS
    .map(s => section(s.title, notes.filter(n => s.kinds.includes(n.kind))))
    .join('\n\n')
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
