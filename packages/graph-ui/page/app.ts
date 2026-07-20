import type { GraphLink, GraphNode, GraphPatch, LogRow } from '@orc/ui-core'
import { act, initSession, session } from './api'
import { renderChat } from './chat'
import { renderDetail } from './detail'
import { LogView } from './log'
import { current, navigate, onChange, type Selection, type Tab } from './nav'
import { renderRequest, type OpenQuestion, type PlanNoteView, type PlansView, type TaskView } from './plan'
import type { GraphRenderer } from './renderer'
import { SigmaRenderer } from './sigma-renderer'
import { Btn, Dot, Empty, NavItem, Section, Tabs, openDialog, toast } from './ui/components'
import { el } from './ui/el'

// ---- shell (sidebar | graph | resizer | detail), composed from ui/ primitives ----
const graphHost = el('div', { class: 'graph-host' })
const newRequestHost = el('div', {})
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
    newRequestHost,
    Section('projects', projectList),
    Section('requests', taskList),
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
let panelPx = 380
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
  panelPx = panelPx > window.innerWidth * 0.5 ? 380 : Math.round(window.innerWidth * 0.7)
  applyPanel()
})

// ---- state ----
// sentinel start: the FIRST onChange fire must see project/node as "changed" so deep links load
let sel: Selection = { project: '', node: null, tab: 'detail' }
let es: EventSource | undefined
let seq = 0
let projects: Array<{ id: string; name: string | null }> = []
const nodes = new Map<string, GraphNode>()
const links = new Map<string, GraphLink>() // client-side edge index: feeds focus mode + knowledge
const linkKey = (l: GraphLink): string => `${l.source}\u0000${l.target}\u0000${l.type}`
let chatTimer: ReturnType<typeof setTimeout> | undefined
let shownPlanVersion: number | null = null
let focusedTask: string | null = null

const TAB_ITEMS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'request', label: 'Request' }, { id: 'detail', label: 'Detail' }, { id: 'chat', label: 'Chat' }, { id: 'log', label: 'Log' },
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

// ---- focus mode: the request's subtree + everything it produced or wrote ----
function focusIds(taskId: string): Set<string> {
  const set = new Set<string>([taskId])
  for (let grew = true; grew;) { // subtree via child edges
    grew = false
    for (const l of links.values())
      if (l.type === 'child' && set.has(l.source) && !set.has(l.target)) { set.add(l.target); grew = true }
  }
  for (let pass = 0; pass < 3; pass++) // steps, then artifacts hanging off steps, then notes
    for (const l of links.values())
      if ((l.type === 'plan' || l.type === 'out' || l.type === 'wrote' || l.type === 'depends') && set.has(l.source)) set.add(l.target)
  const planPrefix = `note:plan-${taskId}\u0000`
  for (const id of nodes.keys()) if (id.startsWith(planPrefix)) set.add(id)
  return set
}

function applyFocus(): void {
  renderer.focus(focusedTask ? focusIds(focusedTask) : null)
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
    onClick: () => navigate({ node: t.id, tab: 'request' }),
  })) : [Empty('no requests yet')]))
  const counts = { task: 0, step: 0, artifact: 0, note: 0 }
  for (const n of nodes.values()) counts[n.type]++
  legend.replaceChildren(...Object.entries(counts).map(([type, n]) =>
    el('div', { class: 'navitem' }, Dot(type), el('span', { class: 'truncate' }, type), el('span', { class: 'meta' }, String(n)))))
}

function renderNewRequest(): void {
  if (!session.actions) { newRequestHost.replaceChildren(); return }
  const b = Btn('+ new request', () => openDialog('new request', [
    { name: 'title', label: 'title', placeholder: 'what should happen?' },
    { name: 'spec', label: 'spec', kind: 'textarea', placeholder: 'details, constraints, outputs…' },
    {
      name: 'mode', label: 'mode', kind: 'select',
      options: [
        { value: 'quick', label: 'quick — single-step template' },
        { value: 'grounded', label: 'grounded — agent analyzes the repo and proposes a decomposition' },
      ],
    },
    { name: 'model', label: 'model', value: 'anthropic/claude-haiku-4-5' },
    { name: 'cwd', label: 'cwd (grounded)', value: session.defaultCwd ?? '' },
  ], 'create', async v => {
    if (!v.title?.trim()) throw new Error('title is required')
    const body = v.mode === 'grounded'
      ? { title: v.title, spec: v.spec, grounded: { modelRef: v.model, cwd: v.cwd } }
      : { title: v.title, spec: v.spec }
    const { taskId } = await act<{ taskId: string }>('newTask', body)
    toast(v.mode === 'grounded' ? 'request created — analyze step running' : 'request created', 'ok')
    navigate({ node: taskId, tab: 'request' })
  }))
  b.classList.add('primary')
  newRequestHost.replaceChildren(b)
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
      const onReply = session.actions
        ? async (text: string) => { await act('reply', { taskId, text }); toast('replied — step resuming', 'ok') }
        : null
      tabBody.replaceChildren(renderChat(items, onReply))
      detailPane.scrollTop = detailPane.scrollHeight
      return
    }
    case 'request': {
      if (!taskId) { tabBody.replaceChildren(Empty('select a request')); return }
      const [plansRes, detailRes, transcript, planNotes] = await Promise.all([
        fetch(`/api/plans?${q({ project: sel.project, task: taskId })}`),
        fetch(`/api/node?${q({ project: sel.project, id: taskId })}`),
        (await fetch(`/api/transcript?${q({ project: sel.project, task: taskId })}`)).json() as Promise<Array<{ kind: string; question?: string; answer?: string | null; stepId?: string }>>,
        (await fetch(`/api/plan-notes?${q({ project: sel.project, task: taskId })}`)).json() as Promise<PlanNoteView[]>,
      ])
      const subtree = focusIds(taskId) // same walk focus mode uses — feeds the knowledge list
      const wrote = [...links.values()].filter(l => l.type === 'wrote' && subtree.has(l.source))
        .map(l => nodes.get(l.target)).filter((n): n is GraphNode => n !== undefined)
        .map(n => ({ id: n.id, label: n.label, detail: n.detail }))
      tabBody.replaceChildren(renderRequest({
        taskId,
        plans: plansRes.ok ? await plansRes.json() as PlansView : null,
        t: detailRes.ok ? await detailRes.json() as TaskView : null,
        open: transcript.filter(i => i.kind === 'question' && i.answer === null)
          .map((i): OpenQuestion => ({ question: i.question ?? '', stepId: i.stepId ?? '' })),
        planNotes,
        knowledge: wrote,
        planScopeName: `plan-${taskId}`,
        shownVersion: shownPlanVersion,
        focused: focusedTask === taskId,
        go: node => navigate({ node, tab: 'detail' }),
        showVersion: v => { shownPlanVersion = v; void renderTab() },
        act: session.actions ? act : null,
        onFocus: on => { focusedTask = on ? taskId : null; applyFocus(); void renderTab() },
      }))
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
      for (const l of env.patch.addLinks) links.set(linkKey(l), l)
      for (const l of env.patch.removeLinks) links.delete(linkKey(l))
      for (const id of env.patch.removeNodeIds)
        for (const [k, l] of links) if (l.source === id || l.target === id) links.delete(k)
      renderer.applyPatch(env.patch)
      renderSidebar()
      if (focusedTask) applyFocus() // fresh knowledge lights up inside the dimmed world
    }
    if (env.summary) {
      if (sel.tab === 'log') logView.append(env.summary)
      // live-follow the open chat AND the request view (step statuses, your-move, knowledge)
      if ((sel.tab === 'chat' || sel.tab === 'request') && env.summary.taskId && env.summary.taskId === selectedTaskId()) {
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
    { seq: number; nodes: GraphNode[]; links: GraphLink[] }
  seq = g.seq
  nodes.clear()
  links.clear()
  for (const n of g.nodes) nodes.set(n.id, n)
  for (const l of g.links) links.set(linkKey(l), l)
  renderer.setGraph(g)
  focusedTask = null
  renderer.focus(null)
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
await initSession()
renderNewRequest()
projects = await (await fetch('/api/projects')).json() as Array<{ id: string; name: string | null }>
if (!current().project && projects[0]) {
  navigate({ project: projects[0].id }) // triggers onChange
} else if (current().project) {
  renderSidebar() // onChange already fired with the deep link; paint names now that they exist
} else {
  projectList.append(Empty('no projects yet'))
}
