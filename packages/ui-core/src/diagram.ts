// Mermaid text + todo-wave layering for plans and decompositions — pure, shared by the web
// conversation cards, the request view, and any future TUI. Labels go through the ONE
// mermaidLabel escaper (contracts) — agent-authored titles must never escape the graph.
import { LINK_KIND, STEP_RUN_STATUS, mermaidLabel } from '@orc/contracts'
import { PALETTE } from './palette'

export interface DiagramStep { id: string; title: string; dependsOn: string[] }
export interface StepStatusLookup { get(id: string): { status: string } | undefined }

const statusClass = (s: string | undefined): string =>
  s === STEP_RUN_STATUS.completed ? 'done'
    : s === STEP_RUN_STATUS.failed ? 'failed'
      : s === STEP_RUN_STATUS.running ? 'running'
        : 'pending'

const THEME = [
  `classDef done fill:${PALETTE.doneFill},stroke:${PALETTE.step},color:${PALETTE.text}`,
  `classDef running fill:${PALETTE.runningFill},stroke:${PALETTE.running},color:${PALETTE.text}`,
  `classDef failed fill:${PALETTE.failedFill},stroke:${PALETTE.danger},color:${PALETTE.text}`,
  `classDef pending fill:${PALETTE.surface},stroke:${PALETTE.edge},color:${PALETTE.textDim}`,
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

// `states` keys on the subplan note id, which is also the child step's id (instantiateFrozenPlan).
// A note with no step yet — the masterplan root, an unapproved proposal — stays pending.
export function decompositionMermaid(notes: DecompositionNote[], states?: StepStatusLookup): string {
  const ids = new Set(notes.map(n => n.id))
  const lines = ['graph TD']
  for (const n of notes) lines.push(`  ${n.id}["${mermaidLabel(n.title)}"]:::${statusClass(states?.get(n.id)?.status)}`)
  for (const n of notes) for (const l of n.links) {
    if (!ids.has(l.id)) continue
    if (l.kind === LINK_KIND.decomposes_into) lines.push(`  ${n.id} --> ${l.id}`)
    // dependency -> dependent, matching planMermaid: in both diagrams an arrow means "runs before"
    else if (l.kind === LINK_KIND.depends_on) lines.push(`  ${l.id} -.-> ${n.id}`)
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
