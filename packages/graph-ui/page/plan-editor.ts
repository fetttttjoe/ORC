// The plan editor — canvas for STRUCTURE (drag steps, draw dependsOn links, auto-layout),
// inspector for FIELDS (title, instructions, model…). Saving proposes a new version through
// the same `edit` action the CLI uses; frozen plans never reach this editor (the entry button
// is gated). @joint/core draws; our draft object stays the single source of truth.
import { dia, shapes } from '@joint/core'
import { DirectedGraph } from '@joint/layout-directed-graph'
import { STRATEGY } from '@orc/contracts'
import type { PlanStepView } from './api'
import { el } from './ui/el'
import { Badge, Btn, KV, toast } from './ui/components'

interface EditorStep extends PlanStepView { }

const NODE_W = 200
const NODE_H = 54

const nodeColors = { body: '#1a1a22', stroke: '#3b3b47', text: '#e4e4e9' }

export function openPlanEditor(opts: {
  steps: PlanStepView[]
  onSave: (steps: PlanStepView[]) => Promise<void>
}): void {
  // deep-copy: the editor owns its draft until save
  const steps: EditorStep[] = structuredClone(opts.steps)
  const byId = () => new Map(steps.map(s => [s.id, s]))

  const canvas = el('div', { class: 'editor-canvas' })
  const inspector = el('div', { class: 'editor-inspector' })
  const overlay = el('div', { class: 'editor-overlay' })

  const graph = new dia.Graph({}, { cellNamespace: shapes })
  const paper = new dia.Paper({
    el: canvas,
    model: graph,
    width: '100%',
    height: '100%',
    cellViewNamespace: shapes,
    background: { color: '#0b0b0f' },
    gridSize: 10,
    defaultLink: () => new shapes.standard.Link({
      attrs: { line: { stroke: '#7aa2f7', strokeWidth: 1.5, targetMarker: { type: 'path', d: 'M 8 -4 0 0 8 4 z' } } },
    }),
    linkPinning: false,
    validateConnection: (srcView, _sm, tgtView) => srcView !== tgtView && tgtView.model.isElement(),
  })

  const nodeFor = (s: EditorStep): dia.Element => new shapes.standard.Rectangle({
    id: s.id,
    size: { width: NODE_W, height: NODE_H },
    attrs: {
      body: { fill: nodeColors.body, stroke: nodeColors.stroke, rx: 8, ry: 8, magnet: true },
      label: { text: `${s.id}\n${s.title.slice(0, 26)}`, fill: nodeColors.text, fontSize: 11, fontFamily: 'Inter, sans-serif' },
    },
  })

  const edgeFor = (from: string, to: string): dia.Link => new shapes.standard.Link({
    source: { id: from }, target: { id: to },
    attrs: { line: { stroke: '#3b3b47', strokeWidth: 1.5, targetMarker: { type: 'path', d: 'M 8 -4 0 0 8 4 z' } } },
  })

  const rebuild = (): void => {
    graph.clear()
    graph.addCells(steps.map(nodeFor))
    graph.addCells(steps.flatMap(s => s.dependsOn.filter(d => byId().has(d)).map(d => edgeFor(d, s.id))))
    autoLayout()
  }

  const autoLayout = (): void => {
    DirectedGraph.layout(graph, { rankDir: 'LR', nodeSep: 30, rankSep: 90, marginX: 40, marginY: 40 })
  }

  // dependsOn derived from the canvas — the one sync point canvas → draft
  const syncDeps = (): void => {
    const incoming = new Map<string, string[]>()
    for (const link of graph.getLinks()) {
      const src = String(link.source().id ?? '')
      const tgt = String(link.target().id ?? '')
      if (src && tgt) (incoming.get(tgt) ?? incoming.set(tgt, []).get(tgt)!).push(src)
    }
    for (const s of steps) s.dependsOn = [...new Set(incoming.get(s.id) ?? [])]
  }

  const hasCycle = (): boolean => {
    const m = byId()
    const seen = new Set<string>()
    const stack = new Set<string>()
    const visit = (id: string): boolean => {
      if (stack.has(id)) return true
      if (seen.has(id)) return false
      seen.add(id); stack.add(id)
      const cyclic = (m.get(id)?.dependsOn ?? []).some(visit)
      stack.delete(id)
      return cyclic
    }
    return steps.some(s => visit(s.id))
  }

  graph.on('remove', () => syncDeps())
  paper.on('link:connect', link => {
    syncDeps()
    if (hasCycle()) {
      link.model.remove()
      syncDeps()
      toast('that dependency would create a cycle', 'warn')
    }
  })

  let selected: EditorStep | null = null
  const field = (label: string, value: string, set: (v: string) => void, kind: 'input' | 'textarea' | 'number' = 'input'): HTMLElement => {
    const input = kind === 'textarea' ? el('textarea', {}) : el('input', {})
    if (input instanceof HTMLInputElement && kind === 'number') input.type = 'number'
    input.value = value
    input.addEventListener('input', () => set(input.value))
    return el('label', { class: 'field' }, el('span', {}, label), input)
  }

  const renderInspector = (): void => {
    if (!selected) {
      inspector.replaceChildren(
        el('div', { class: 'card-title' }, 'plan editor'),
        KV([
          ['add step', 'double-click the canvas'],
          ['dependency', 'drag from one step onto another'],
          ['fields', 'click a step'],
        ]),
      )
      return
    }
    const s = selected
    inspector.replaceChildren(
      el('div', { class: 'card-title' }, s.id, Badge(s.role, 'accent')),
      field('title', s.title, v => { s.title = v; (graph.getCell(s.id) as dia.Element | null)?.attr('label/text', `${s.id}\n${v.slice(0, 26)}`) }),
      field('instructions', s.instructions, v => { s.instructions = v }, 'textarea'),
      field('model', s.modelRef, v => { s.modelRef = v }),
      field('role', s.role, v => { s.role = v }),
      field('max iterations', String(s.maxIterations), v => { s.maxIterations = Math.max(1, Number(v) || 1) }, 'number'),
      field('skills (comma)', s.skillRefs.join(', '), v => { s.skillRefs = v.split(',').map(x => x.trim()).filter(Boolean) }),
      Btn('delete step', () => {
        const idx = steps.findIndex(x => x.id === s.id)
        if (idx >= 0) steps.splice(idx, 1)
        for (const other of steps) other.dependsOn = other.dependsOn.filter(d => d !== s.id)
        selected = null
        rebuild()
        renderInspector()
      }, 'danger'),
    )
  }

  paper.on('element:pointerclick', view => {
    selected = byId().get(String(view.model.id)) ?? null
    renderInspector()
  })
  paper.on('blank:pointerclick', () => { selected = null; renderInspector() })
  paper.on('blank:pointerdblclick', (_evt, x, y) => {
    let n = steps.length + 1
    while (byId().has(`s${n}`)) n++
    const s: EditorStep = {
      id: `s${n}`, role: 'worker', title: `step ${n}`, instructions: 'describe the work',
      modelRef: 'anthropic/claude-haiku-4-5', skillRefs: [], maxIterations: 10, dependsOn: [],
    }
    steps.push(s)
    const node = nodeFor(s)
    node.position(x - NODE_W / 2, y - NODE_H / 2)
    graph.addCell(node)
    selected = s
    renderInspector()
  })

  const close = (): void => overlay.remove()

  overlay.append(
    el('div', { class: 'editor-toolbar' },
      el('div', { class: 'card-title' }, 'edit plan', Badge(`${steps.length} steps`, 'accent')),
      el('span', { class: 'grow' }),
      Btn('auto-layout', () => autoLayout(), 'muted'),
      Btn('discard', close, 'muted'),
      Btn('save as new version', async () => {
        syncDeps()
        if (steps.length === 0) { toast('a plan needs at least one step', 'warn'); return }
        if (hasCycle()) { toast('resolve the dependency cycle first', 'warn'); return }
        await opts.onSave(steps)
        close()
      }),
    ),
    el('div', { class: 'editor-main' }, canvas, inspector),
  )
  document.body.append(overlay)
  rebuild()
  renderInspector()
}

// full PlanDraft from the edited steps — editor-untouched fields get the sanctioned defaults
export function draftFromSteps(steps: PlanStepView[]): Record<string, unknown> {
  return {
    strategyRef: STRATEGY.single,
    costEstimateUSD: null,
    steps: steps.map(s => ({
      id: s.id, role: s.role, title: s.title, instructions: s.instructions,
      executorRef: 'api-loop', modelRef: s.modelRef, skillRefs: s.skillRefs, toolRefs: [],
      isolation: 'local', zone: [], maxIterations: s.maxIterations, dependsOn: s.dependsOn,
    })),
  }
}
