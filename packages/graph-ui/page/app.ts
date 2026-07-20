import type { GraphLink, GraphNode, LogRow } from '@orc/ui-core'
import { api, initApi, session, type Project } from './api'
import { renderChat } from './chat'
import { Conversation } from './conversation'
import { renderDetail } from './detail'
import { LogView } from './log'
import { current, navigate, onChange, type Selection, type Tab, type View } from './nav'
import { EDGE, NODE_PREFIX, planScopeName } from '@orc/ui-core/graph'
import { renderRequest, type OpenQuestion, type PlanNoteView, type PlansView, type TaskView } from './plan'
import type { GraphRenderer } from './renderer'
import { SigmaRenderer } from './sigma-renderer'
import { Btn, Dot, Empty, NavItem, Section, Tabs, openDialog, toast } from './ui/components'
import { el } from './ui/el'

// ---- shell v2: nav | conversation | resizer | dock(graph + inspector overlay) ----
const graphHost = el('div', { class: 'graph-host' })
const viewModes = el('div', { class: 'viewmodes' })
const newRequestHost = el('div', {})
const projectList = el('div', { class: 'section' })
const taskList = el('div', { class: 'section' })
const statusDot = Dot('')
const statusText = el('span', {}, 'connecting…')
const inspectorTabs = el('div', {})
const inspectorBody = el('div', {})
const inspector = el('div', { class: 'inspector' },
  el('div', { class: 'inspector-head' },
    el('span', { class: 'grow' }),
    el('button', { class: 'iconbtn', title: 'close', onClick: () => navigate({ node: null }) }, '×'),
  ),
  inspectorTabs, inspectorBody)
const resizer = el('div', { class: 'resizer' })
const dock = el('main', { class: 'main' }, graphHost, inspector)
const app = el('div', { class: 'app' },
  el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' }, el('span', { class: 'logo' }), el('span', {}, 'orc')),
    viewModes,
    newRequestHost,
    Section('chats', projectList),
    Section('requests', taskList),
    el('div', { class: 'statusbar' }, statusDot, statusText),
  ),
  el('div', {}, ''), // conversation mounts here after session init
  resizer,
  dock,
)
document.body.append(app)

const renderer: GraphRenderer = new SigmaRenderer(graphHost)
renderer.onNodeClick(id => navigate({ node: id }))
const logView = new LogView(node => navigate({ node, tab: 'detail' }))

// ---- dock resize (split view only; other views are class-driven) ----
let dockPx = Math.round(window.innerWidth * 0.4)
const applyColumns = (): void => {
  app.style.gridTemplateColumns = sel.view === 'split' ? `240px 1fr 5px ${dockPx}px` : ''
}
resizer.addEventListener('pointerdown', (down: PointerEvent) => {
  down.preventDefault()
  const startX = down.clientX
  const startPx = dockPx
  const move = (m: PointerEvent): void => {
    dockPx = Math.min(Math.max(startPx + (startX - m.clientX), 320), window.innerWidth - 480)
    applyColumns()
  }
  const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

// ---- state ----
// sentinel start: the FIRST onChange fire must see project/node as "changed" so deep links load
let sel: Selection = { project: '', node: null, tab: 'detail', view: 'split' }
let stream: { close: () => void } | undefined
let seq = 0
let projects: Project[] = []
const nodes = new Map<string, GraphNode>()
const links = new Map<string, GraphLink>() // client-side edge index: feeds focus mode + knowledge
const linkKey = (l: GraphLink): string => `${l.source}\u0000${l.target}\u0000${l.type}`
let chatTimer: ReturnType<typeof setTimeout> | undefined
let shownPlanVersion: number | null = null
let focusedTask: string | null = null
let conversation: Conversation | null = null

const TAB_ITEMS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'request', label: 'Request' }, { id: 'detail', label: 'Detail' }, { id: 'chat', label: 'Chat' }, { id: 'log', label: 'Log' },
]
const VIEW_ITEMS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'chat', label: 'chat' }, { id: 'split', label: 'split' }, { id: 'graph', label: 'graph' },
]

const selectedTaskId = (): string | null => {
  if (!sel.node) return null
  if (nodes.get(sel.node)?.type === 'task') return sel.node
  if (sel.node.startsWith(NODE_PREFIX.step) || sel.node.startsWith(NODE_PREFIX.artifact)) return sel.node.split(':')[1] ?? null
  return null
}

// ---- focus mode: the request's subtree + everything it produced or wrote ----
function focusIds(taskId: string): Set<string> {
  const set = new Set<string>([taskId])
  for (let grew = true; grew;) { // subtree via child edges
    grew = false
    for (const l of links.values())
      if (l.type === EDGE.child && set.has(l.source) && !set.has(l.target)) { set.add(l.target); grew = true }
  }
  for (let pass = 0; pass < 3; pass++) // steps, then artifacts hanging off steps, then notes
    for (const l of links.values())
      if ((l.type === EDGE.plan || l.type === EDGE.out || l.type === EDGE.wrote || l.type === EDGE.depends) && set.has(l.source)) set.add(l.target)
  const planPrefix = `${NODE_PREFIX.note}${planScopeName(taskId)}\u0000`
  for (const id of nodes.keys()) if (id.startsWith(planPrefix)) set.add(id)
  return set
}

const applyFocus = (): void => renderer.focus(focusedTask ? focusIds(focusedTask) : null)

// ---- sidebar ----
function setStatus(live: boolean, text: string): void {
  statusDot.className = `dot${live ? ' live' : ''}`
  statusText.textContent = text
}

function renderSidebar(): void {
  viewModes.replaceChildren(...VIEW_ITEMS.map(v =>
    el('button', { class: `tab${v.id === sel.view ? ' active' : ''}`, onClick: () => navigate({ view: v.id }) }, v.label)))
  projectList.replaceChildren(...projects.map(p => NavItem({
    label: p.name ?? p.id.slice(0, 8),
    dot: p.id === sel.project ? 'live' : '',
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
}

function renderChatManagement(): void {
  if (!session.actions) return
  const renameBtn = Btn('rename chat', () => openDialog('rename this project chat', [
    { name: 'name', label: 'name', value: projects.find(p => p.id === sel.project)?.name ?? '' },
  ], 'rename', async v => {
    if (!v.name?.trim()) throw new Error('name is required')
    await api.act('renameProject', { name: v.name.trim() })
    toast('renamed', 'ok')
    projects = await api.projects()
    renderSidebar()
  }), 'muted')
  const newChatBtn = Btn('+ new chat', () => openDialog('new project chat', [
    { name: 'name', label: 'name', placeholder: 'project name' },
    { name: 'dir', label: 'directory', value: session.defaultCwd ?? '' },
  ], 'create', async v => {
    if (!v.name?.trim() || !v.dir?.trim()) throw new Error('name and directory are required')
    const { projectId } = await api.act<{ projectId: string }>('newProject', { dir: v.dir.trim(), name: v.name.trim() })
    toast('project chat created', 'ok')
    projects = await api.projects()
    navigate({ project: projectId, node: null, tab: 'detail' })
  }), 'muted')
  newRequestHost.append(el('div', { class: 'row-split' }, newChatBtn, renameBtn))
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
    const { taskId } = await api.act<{ taskId: string }>('newTask', body)
    toast(v.mode === 'grounded' ? 'request created — analyze step running' : 'request created', 'ok')
    navigate({ node: taskId, tab: 'request' })
  }))
  b.classList.add('primary')
  newRequestHost.replaceChildren(b)
  renderChatManagement()
}

// ---- inspector (the old tab system, now an overlay in the dock) ----
async function renderInspector(): Promise<void> {
  if (!sel.node) { inspector.style.display = 'none'; return }
  inspector.style.display = ''
  inspectorTabs.replaceChildren(Tabs(TAB_ITEMS, sel.tab, id => navigate({ tab: id as Tab })))
  const taskId = selectedTaskId()
  switch (sel.tab) {
    case 'detail': {
      const detail = await api.node(sel.project, sel.node)
      inspectorBody.replaceChildren(renderDetail(sel.node, detail, node => navigate({ node, tab: 'detail' })))
      return
    }
    case 'chat': {
      if (!taskId) { inspectorBody.replaceChildren(Empty('select a task or step')); return }
      const step = sel.node?.startsWith(NODE_PREFIX.step) ? sel.node.split(':')[2] : undefined
      const items = await api.transcript(sel.project, taskId, step)
      const onReply = session.actions
        ? async (text: string) => { await api.act('reply', { taskId, text }); toast('replied — step resuming', 'ok') }
        : null
      inspectorBody.replaceChildren(renderChat(items, onReply))
      return
    }
    case 'request': {
      if (!taskId) { inspectorBody.replaceChildren(Empty('select a request')); return }
      const [plans, detail, transcript, planNotes] = await Promise.all([
        api.plans(sel.project, taskId),
        api.node(sel.project, taskId),
        api.transcript(sel.project, taskId),
        api.planNotes(sel.project, taskId),
      ])
      const subtree = focusIds(taskId)
      const wrote = [...links.values()].filter(l => l.type === EDGE.wrote && subtree.has(l.source))
        .map(l => nodes.get(l.target)).filter((n): n is GraphNode => n !== undefined)
        .map(n => ({ id: n.id, label: n.label, detail: n.detail }))
      inspectorBody.replaceChildren(renderRequest({
        taskId,
        plans,
        t: detail as TaskView | null,
        decompositionMermaid: planNotes.mermaid,
        open: transcript.filter((i): i is Extract<typeof i, { kind: 'question' }> => i.kind === 'question' && i.answer === null)
          .map((i): OpenQuestion => ({ question: i.question, stepId: i.stepId })),
        planNotes: planNotes.notes,
        knowledge: wrote,
        planScopeName: planScopeName(taskId),
        shownVersion: shownPlanVersion,
        focused: focusedTask === taskId,
        go: node => navigate({ node, tab: 'detail' }),
        showVersion: v => { shownPlanVersion = v; void renderInspector() },
        act: session.actions ? api.act : null,
        onFocus: on => { focusedTask = on ? taskId : null; applyFocus(); void renderInspector() },
      }))
      return
    }
    case 'log': {
      const rows = await api.log(sel.project, { task: taskId ?? undefined })
      logView.setRows(rows, taskId)
      inspectorBody.replaceChildren(logView.root)
      return
    }
  }
}

// ---- live stream ----
function watch(fromSeq: number): void {
  stream?.close()
  stream = api.eventStream(sel.project, fromSeq, {
    onLive: () => setStatus(true, `live · seq ${seq}`),
    onDown: () => setStatus(false, 'reconnecting…'),
    onEnvelope: (env, envSeq) => {
      seq = envSeq || seq
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
        conversation?.addSystemRow(env.summary)
        if (sel.node && sel.tab === 'log') logView.append(env.summary)
        if (sel.node && (sel.tab === 'chat' || sel.tab === 'request') && env.summary.taskId && env.summary.taskId === selectedTaskId()) {
          clearTimeout(chatTimer)
          chatTimer = setTimeout(() => void renderInspector(), 300)
        }
      }
      setStatus(true, `live · seq ${seq}`)
    },
  })
}

// ---- selection routing (the ONE renderer of selection) ----
async function loadProject(): Promise<void> {
  const g = await api.graph(sel.project)
  seq = g.seq
  nodes.clear()
  links.clear()
  for (const n of g.nodes) nodes.set(n.id, n)
  for (const l of g.links) links.set(linkKey(l), l)
  renderer.setGraph(g)
  focusedTask = null
  renderer.focus(null)
  conversation?.setProject(sel.project)
  watch(g.seq)
}

onChange(s => {
  void (async () => {
    const projectChanged = s.project !== sel.project
    const nodeChanged = s.node !== sel.node
    sel = s
    app.className = `app view-${sel.view}`
    applyColumns()
    if (projectChanged) { shownPlanVersion = null; await loadProject() }
    if (nodeChanged) shownPlanVersion = null
    renderer.select(sel.node)
    renderSidebar()
    await renderInspector()
  })()
})

// ---- boot ----
initApi({ onError: err => toast(`${err.endpoint}: ${err.message}`, 'danger') })
await api.initSession()
conversation = new Conversation(node => navigate({ node, tab: 'detail' }))
app.children[1]!.replaceWith(conversation.root)
renderNewRequest()
projects = await api.projects()
if (!current().project && projects[0]) {
  navigate({ project: projects[0].id }) // triggers onChange
} else if (current().project) {
  renderSidebar()
  conversation.setProject(current().project)
} else {
  projectList.append(Empty('no projects yet'))
}
