// The ONE way a plan is drawn. Every surface that shows a plan — the chat card, the request
// inspector, anything added later — renders through `planVisual`, so the two cannot drift into
// disagreeing about the same plan. They already had: the chat card skipped the diagram for a
// one-step plan while the inspector always drew it, and a state badge added to one was invisible
// in the other. Whichever surface is "right" is a question this file answers once.
//
// Pure presentation: it takes the shape /api/plans already returns and knows nothing about
// fetching, caching, or which task is selected. `onStep` is the only hook — it turns each step
// into a door, and a surface that has nowhere to go simply omits it.
import type { TodoWave } from '@orc/ui-core'
import { el } from './ui/el'
import { Badge, statusTone } from './ui/components'
import { mermaidInto } from './mermaid'
import { planState } from './status-style'

export interface PlanVisual { version: number; mermaid: string; waves: TodoWave[] }

// Whether the plan is a one-step template. This labels the plan — it no longer decides whether the
// diagram is drawn: the diagram ALWAYS renders, so a reader's eye lands in the same place on every
// plan and the shape of the work is visible without reading chips. A one-step plan is simply a
// one-node diagram, which is honest rather than empty.
export const isSingleStep = (waves: readonly TodoWave[]): boolean =>
  waves.length === 1 && waves[0]?.steps.length === 1

// The step chips: the compact, always-present progress row. `onStep` makes each one a door into
// the graph — click → that step's audit view (attempts, run state, transcript).
export function renderWaves(waves: readonly TodoWave[], onStep?: (stepId: string) => void): HTMLElement {
  return el('div', { class: 'waves' }, ...waves.map(w =>
    el('div', { class: 'wave' },
      el('span', { class: 'wave-label' }, `wave ${w.wave}`, w.parallel ? Badge('parallel', 'accent') : ''),
      ...w.steps.map(s => el('span', {
        class: `wave-step ${s.status}${onStep ? ' link' : ''}`,
        onClick: onStep ? () => onStep(s.id) : undefined,
        title: onStep ? 'open step in inspector' : undefined,
        data: { step: s.id },
      },
        s.status === 'completed' ? '✓ ' : s.status === 'failed' ? '✗ ' : s.status === 'running' ? '◔ ' : '○ ', s.title)),
    )))
}

// The title row: state first, because whether the plan finished is what a reader scanning either
// surface wants before anything else. Exported separately so a caller that supplies its own
// heading (the inspector's Card) can still show the same badges in the same order.
export function planTitle(v: PlanVisual): HTMLElement {
  const state = planState(v.waves)
  return el('div', { class: 'card-title' }, `plan v${v.version}`,
    Badge(state, statusTone(state)),
    isSingleStep(v.waves) ? Badge('single-step template', 'muted') : Badge(`${v.waves.length} wave(s)`, 'accent'))
}

// The whole visualisation, in the order every surface shows it: title, diagram (when there is one
// worth drawing), chips. Returns the nodes rather than a wrapper so a caller can drop them into
// its own card without a redundant div.
export function planVisual(v: PlanVisual, opts: { onStep?: (stepId: string) => void; title?: boolean } = {}): HTMLElement[] {
  const out: HTMLElement[] = []
  if (opts.title !== false) out.push(planTitle(v))
  const diagram = el('div', { class: 'diagram' })
  void mermaidInto(diagram, v.mermaid) // async by design: the card renders now, the SVG lands later
  out.push(diagram, renderWaves(v.waves, opts.onStep))
  return out
}

// The identity of what is currently drawn — version plus every step status. A surface that caches
// its card compares this to decide whether a re-render would change anything (an approval landing
// straight after a proposal must not repaint). It lives here because it must cover exactly what
// planVisual reads: add a field to the visualisation and this is the line that has to grow.
export const planVisualKey = (v: PlanVisual): string =>
  `${v.version}:${v.waves.map(w => w.steps.map(s => s.status).join(',')).join('|')}`
