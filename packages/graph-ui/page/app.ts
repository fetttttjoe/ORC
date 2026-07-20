import type { GraphNode, GraphPatch, LogRow } from '@orc/ui-core'
import { renderChat } from './chat'
import { renderDetail } from './detail'
import { LogView } from './log'
import { current, navigate, onChange, type Selection, type Tab } from './nav'
import { renderRoad, type OpenQuestion, type PlansView, type TaskView } from './plan'
import type { GraphRenderer } from './renderer'
import { SigmaRenderer } from './sigma-renderer'
import { Dot, Empty, NavItem, Section, Tabs } from './ui/components'
import { el } from './ui/el'

// ---- shell (sidebar | graph | resizer | detail), composed from ui/ primitives ----
const graphHost = el('div', { class: 'graph-host' })
const projectList = el('div', { class: 'section' })
const taskList = el('div', { class: 'section' })
const legend = el('div', { class: 'section' })
const statusDot = Dot('')
const statusText = el('span', {}, 'connecting…')
const tabHost = el('div', {})
const tabBody = el('div', {})
const resizer = el('div', { class: 'resizer' })
const detailPane = el('aside', { class: 'detail' }, tabHost, tabBody)
const app = el('div', { class: 'app' },
  el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' }, el('span', { class: 'logo' }), 'orc graph'),
    Section('projects', projectList),
    Section('tasks', taskList),
    Section('graph', legend),
    el('div', { class: 'statusbar' }, statusDot, statusText),
  ),
  el('main', { class: 'main' }, graphHost),
  resizer,
  detailPane,
)
document.body.append(app)

const renderer: GraphRenderer = new SigmaRenderer(graphHost)
renderer.onNodeClick(id => navigate({ node: id }))
const logView = new LogView(node => navigate({ node, tab: 'detail' }))

// ---- panel resize + maximize ----
let panelPx = 360
const applyPanel = (): void => { app.style.gridTemplateColumns = `240px 1fr 5px ${panelPx}px` }
applyPanel()
resizer.addEventListener('pointerdown', (down: PointerEvent) => {
  down.preventDefault()
  const startX = down.clientX
  const startPx = panelPx
  const move = (m: PointerEvent): void => {
    panelPx = Math.min(Math.max(startPx + (startX - m.clientX), 260), window.innerWidth - 420)
    applyPanel()
  }
  const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})
resizer.addEventListener('dblclick', () => {
  panelPx = panelPx > window.innerWidth * 0.5 ? 360 : Math.round(window.innerWidth * 0.7)
  applyPanel()
})

// ---- state ----
// sentinel start: the FIRST onChange fire must see project/node as "changed" so deep links load
let sel: Selection = { project: '', node: null, tab: 'detail' }
let es: EventSource | undefined
let seq = 0
let projects: Array<{ id: string; name: string | null }> = []
const nodes = new Map<string, GraphNode>() // id → node, feeds task tree + legend
let chatTimer: ReturnType<typeof setTimeout> | undefined
let shownPlanVersion: number | null = null

const TAB_ITEMS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'detail', label: 'Detail' }, { id: 'chat', label: 'Chat' }, { id: 'plan', label: 'Plan' }, { id: 'log', label: 'Log' },
]

const q = (params: Record<string, string | undefined>): string =>
  Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

const selectedTaskId = (): string | null => {
  if (!sel.node) return null
  if (nodes.get(sel.node)?.type === 'task') return sel.node
  if (sel.node.startsWith('step:') || sel.node.startsWith('artifact:')) return sel.node.split(':')[1] ?? null
  return null
}

// ---- sidebar ----
function setStatus(live: boolean, text: string): void {
  statusDot.className = `dot${live ? ' live' : ''}`
  statusText.textContent = text
}

function renderSidebar(): void {
  projectList.replaceChildren(...projects.map(p => NavItem({
    label: p.name ?? p.id.slice(0, 8),
    active: p.id === sel.project,
    onClick: () => navigate({ project: p.id, node: null, tab: 'detail' }),
  })))
  const tasks = [...nodes.values()].filter(n => n.type === 'task')
  taskList.replaceChildren(...(tasks.length ? tasks.map(t => NavItem({
    label: t.label,
    dot: 'task',
    meta: t.detail,
    active: t.id === sel.node,
    onClick: () => navigate({ node: t.id, tab: 'chat' }),
  })) : [Empty('no tasks')]))
  const counts = { task: 0, step: 0, artifact: 0, note: 0 }
  for (const n of nodes.values()) counts[n.type]++
  legend.replaceChildren(...Object.entries(counts).map(([type, n]) =>
    el('div', { class: 'navitem' }, Dot(type), el('span', { class: 'truncate' }, type), el('span', { class: 'meta' }, String(n)))))
}

// ---- tab rendering ----
async function renderTab(): Promise<void> {
  tabHost.replaceChildren(Tabs(TAB_ITEMS, sel.tab, id => navigate({ tab: id as Tab })))
  const taskId = selectedTaskId()
  switch (sel.tab) {
    case 'detail': {
      if (!sel.node) { tabBody.replaceChildren(Empty('click a node')); return }
      const res = await fetch(`/api/node?${q({ project: sel.project, id: sel.node })}`)
      tabBody.replaceChildren(renderDetail(sel.node, res.ok ? await res.json() : null, node => navigate({ node, tab: 'detail' })))
      return
    }
    case 'chat': {
      if (!taskId) { tabBody.replaceChildren(Empty('select a task or step')); return }
      const step = sel.node?.startsWith('step:') ? sel.node.split(':')[2] : undefined
      const items = await (await fetch(`/api/transcript?${q({ project: sel.project, task: taskId, step })}`)).json()
      tabBody.replaceChildren(renderChat(items))
      const scroller = detailPane
      scroller.scrollTop = scroller.scrollHeight
      return
    }
    case 'plan': {
      if (!taskId) { tabBody.replaceChildren(Empty('select a task')); return }
      // the road needs the plan, the live step/artifact states, and any open questions
      const [plansRes, detailRes, transcript] = await Promise.all([
        fetch(`/api/plans?${q({ project: sel.project, task: taskId })}`),
        fetch(`/api/node?${q({ project: sel.project, id: taskId })}`),
        (await fetch(`/api/transcript?${q({ project: sel.project, task: taskId })}`)).json() as Promise<Array<{ kind: string; question?: string; answer?: string | null; stepId?: string }>>,
      ])
      const plans = plansRes.ok ? await plansRes.json() as PlansView : null
      const detail = detailRes.ok ? await detailRes.json() as TaskView : null
      const open: OpenQuestion[] = transcript
        .filter(i => i.kind === 'question' && i.answer === null)
        .map(i => ({ question: i.question ?? '', stepId: i.stepId ?? '' }))
      tabBody.replaceChildren(renderRoad(taskId, plans, detail, open, shownPlanVersion, node => navigate({ node, tab: 'detail' }), v => { shownPlanVersion = v; void renderTab() }))
      return
    }
    case 'log': {
      const rows = await (await fetch(`/api/log?${q({ project: sel.project, task: taskId ?? undefined })}`)).json() as LogRow[]
      logView.setRows(rows, taskId)
      tabBody.replaceChildren(logView.root)
      return
    }
  }
}

// ---- live stream ----
function watch(fromSeq: number): void {
  es?.close()
  es = new EventSource(`/api/stream?${q({ project: sel.project, fromSeq: String(fromSeq) })}`)
  es.onopen = () => setStatus(true, `live · seq ${seq}`)
  es.onerror = () => setStatus(false, 'reconnecting…')
  es.onmessage = m => {
    seq = Number(m.lastEventId) || seq
    const env = JSON.parse(m.data) as { patch: GraphPatch | null; summary: LogRow | null }
    if (env.patch) {
      for (const n of [...env.patch.addNodes, ...env.patch.updateNodes]) nodes.set(n.id, n)
      for (const id of env.patch.removeNodeIds) nodes.delete(id)
      renderer.applyPatch(env.patch)
      renderSidebar()
    }
    if (env.summary) {
      if (sel.tab === 'log') logView.append(env.summary)
      // live-follow the open chat AND the road: refetch (debounced) when the event belongs
      // to the selection — the road's step statuses and your-move callout stay current
      if ((sel.tab === 'chat' || sel.tab === 'plan') && env.summary.taskId && env.summary.taskId === selectedTaskId()) {
        clearTimeout(chatTimer)
        chatTimer = setTimeout(() => void renderTab(), 300)
      }
    }
    setStatus(true, `live · seq ${seq}`)
  }
}

// ---- selection routing (the ONE renderer of selection) ----
async function loadProject(): Promise<void> {
  const g = await (await fetch(`/api/graph?${q({ project: sel.project })}`)).json() as
    { seq: number; nodes: GraphNode[]; links: never[] }
  seq = g.seq
  nodes.clear()
  for (const n of g.nodes) nodes.set(n.id, n)
  renderer.setGraph(g)
  watch(g.seq)
}

onChange(s => {
  void (async () => {
    const projectChanged = s.project !== sel.project
    const nodeChanged = s.node !== sel.node
    sel = s
    if (projectChanged) { shownPlanVersion = null; await loadProject() }
    if (nodeChanged) shownPlanVersion = null
    renderer.select(sel.node)
    renderSidebar()
    await renderTab()
  })()
})

// ---- boot ----
projects = await (await fetch('/api/projects')).json() as Array<{ id: string; name: string | null }>
if (!current().project && projects[0]) {
  navigate({ project: projects[0].id }) // triggers onChange
} else if (current().project) {
  // onChange fired already at registration with the hash selection — but before projects
  // loaded; re-render the sidebar now that names exist
  renderSidebar()
} else {
  projectList.append(Empty('no projects yet'))
}
