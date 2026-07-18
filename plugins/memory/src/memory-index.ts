import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { MemoryNote, NoteKind } from '@orc/contracts'
import { frontmatter } from '@orc/vault-projector'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { writeMemoryFile } from './write-note'

// mermaid labels: double quotes end the label — never let note data break the graph
const label = (s: string): string => s.replaceAll('"', "'")

const SECTIONS: { title: string; kinds: NoteKind[] }[] = [
  { title: 'Current architecture', kinds: ['architecture_current'] },
  { title: 'Target architecture', kinds: ['architecture_target'] },
  { title: 'Decisions and facts', kinds: ['decision', 'fact', 'documentation'] },
]

function section(title: string, notes: MemoryNote[]): string {
  if (notes.length === 0) return `## ${title}\n\n_none_`
  const node = new Map(notes.map((n, i) => [`${n.scope}:${n.id}`, `n${i}`]))
  const lines = ['```mermaid', 'graph TD']
  for (const n of notes) {
    const name = node.get(`${n.scope}:${n.id}`)
    lines.push(`  ${name}["${label(n.title)}"]`)
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

function listFiles(root: string, rel = ''): string[] {
  const dir = path.join(root, rel)
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return []
  return readdirSync(dir).flatMap(entry => {
    const child = rel === '' ? entry : `${rel}/${entry}`
    return statSync(path.join(root, child)).isDirectory() ? listFiles(root, child) : [child]
  })
}
