// Mermaid text + todo-wave layering for plans and decompositions — pure, shared by the web
// conversation cards, the request view, and any future TUI. Labels go through the vault's
// mermaidLabel escaper (agent-authored titles must never escape the graph).
import { mermaidLabel } from '@orc/vault-projector'

export interface DiagramStep { id: string; title: string; dependsOn: string[] }
export interface StepStatusLookup { get(id: string): { status: string } | undefined }

const statusClass = (s: string | undefined): string =>
  s === 'completed' ? 'done' : s === 'failed' ? 'failed' : s === 'running' ? 'running' : 'pending'

const THEME = [
  'classDef done fill:#1f5c31,stroke:#9ece6a,color:#e4e4e9',
  'classDef running fill:#5c4a1f,stroke:#e0af68,color:#e4e4e9',
  'classDef failed fill:#5c1f2a,stroke:#f7768e,color:#e4e4e9',
  'classDef pending fill:#22222c,stroke:#3b3b47,color:#8b8b96',
]

export function planMermaid(steps: DiagramStep[], states?: StepStatusLookup): string {
  const lines = ['graph TD']
  for (const s of steps)
    lines.push(`  ${s.id}["${mermaidLabel(s.title)}"]:::${statusClass(states?.get(s.id)?.status)}`)
  for (const s of steps) for (const d of s.dependsOn) lines.push(`  ${d} --> ${s.id}`)
  lines.push(...THEME.map(l => `  ${l}`))
  return lines.join('\n')
}

export interface DecompositionNote { id: string; title: string; links: Array<{ id: string; kind: string }> }

export function decompositionMermaid(notes: DecompositionNote[]): string {
  const ids = new Set(notes.map(n => n.id))
  const lines = ['graph TD']
  for (const n of notes) lines.push(`  ${n.id}["${mermaidLabel(n.title)}"]:::pending`)
  for (const n of notes) for (const l of n.links) {
    if (!ids.has(l.id)) continue
    if (l.kind === 'decomposes_into') lines.push(`  ${n.id} --> ${l.id}`)
    else if (l.kind === 'depends_on') lines.push(`  ${n.id} -.-> ${l.id}`)
  }
  lines.push(...THEME.map(l => `  ${l}`))
  return lines.join('\n')
}

export interface TodoWave { wave: number; parallel: boolean; steps: Array<{ id: string; title: string; status: string }> }

// Kahn layering: wave N = every step whose dependencies all sit in earlier waves. Steps sharing
// a wave can run in parallel — exactly how the run scheduler launches them.
export function todoWaves(steps: DiagramStep[], states?: StepStatusLookup): TodoWave[] {
  const waves: TodoWave[] = []
  const placed = new Set<string>()
  let rest = steps
  for (let n = 1; rest.length > 0; n++) {
    const ready = rest.filter(s => s.dependsOn.every(d => placed.has(d) || !steps.some(x => x.id === d)))
    if (ready.length === 0) break // cycle/dangling: stop layering rather than loop
    for (const s of ready) placed.add(s.id)
    waves.push({
      wave: n,
      parallel: ready.length > 1,
      steps: ready.map(s => ({ id: s.id, title: s.title, status: states?.get(s.id)?.status ?? 'pending' })),
    })
    rest = rest.filter(s => !placed.has(s.id))
  }
  return waves
}
