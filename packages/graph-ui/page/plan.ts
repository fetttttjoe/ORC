// Request tab — the journey view: where this request stands (lifecycle rail), the single next
// human action (buttons when the server has actions, command chips otherwise), the grounded
// decomposition with refine controls, the road of steps, and the knowledge this request grew.
import { noteNodeId, stepNodeId } from '@orc/ui-core/graph' // browser-safe subpath — never the ui-core index
import { el } from './ui/el'
import { Badge, Btn, Card, Dot, Empty, KV, Link, Pre, Tabs, statusTone, toast } from './ui/components'

export interface PlanStepView {
  id: string; title: string; role: string; instructions: string
  modelRef: string; skillRefs: string[]; maxIterations: number; dependsOn: string[]
}
export interface PlansView { versions: Array<{ version: number; steps: PlanStepView[] }>; approvedVersion: number | null }
export interface TaskView {
  task: { id: string; title: string; status: string }
  steps: Array<{ stepId: string; status: string; iterations: number }>
  artifacts: Array<{ path: string; size: number }>
}
export interface OpenQuestion { question: string; stepId: string }
export interface PlanNoteView {
  id: string; title: string; summary: string; rationale: string
  uncertainty: string[]
  links: Array<{ id: string; kind: string }>
}
export type Act = <T = unknown>(name: string, body: unknown) => Promise<T>

export interface RequestCtx {
  taskId: string
  plans: PlansView | null
  t: TaskView | null
  open: OpenQuestion[]
  planNotes: PlanNoteView[]
  knowledge: Array<{ id: string; label: string; detail: string }>
  planScopeName: string // `plan-<taskId>` — where decomposition notes live in the graph
  shownVersion: number | null
  focused: boolean
  go: (node: string) => void
  showVersion: (v: number) => void
  act: Act | null
  onFocus: (on: boolean) => void
}

// deps-respecting order: the road reads top-to-bottom as execution proceeds
function topoOrder(steps: PlanStepView[]): PlanStepView[] {
  const placed = new Set<string>()
  const out: PlanStepView[] = []
  let rest = steps
  while (rest.length) {
    const ready = rest.filter(s => s.dependsOn.every(d => placed.has(d)))
    if (ready.length === 0) return [...out, ...rest] // cycle/dangling: render rather than loop
    for (const s of ready) { placed.add(s.id); out.push(s) }
    rest = rest.filter(s => !placed.has(s.id))
  }
  return out
}

const cmdChip = (cmd: string): HTMLElement =>
  el('code', { class: 'cmd', title: 'click to copy', onClick: () => void navigator.clipboard.writeText(cmd) }, cmd)

interface Move { text: string; cmd: string | null; tone: 'danger' | 'warn' | 'accent' | 'ok'; button: HTMLElement | null }

// the single "what should the human do now" decision — precedence: failure > question > gates
function yourMove(t: TaskView, open: OpenQuestion[], act: Act | null): Move | null {
  const id = t.task.id
  const failed = t.steps.find(s => s.status === 'failed')
  if (failed) return {
    text: `step '${failed.stepId}' failed — inspect its chat, then retry`, tone: 'danger',
    cmd: `orc retry ${id}`,
    button: act && Btn('retry', async () => { await act('retry', { taskId: id }); toast('retry started', 'ok') }, 'danger'),
  }
  if (open.length > 0) {
    const input = el('input', {})
    input.placeholder = 'your answer…'
    return {
      text: `the agent is asking: “${open[0]!.question}”`, tone: 'warn',
      cmd: act ? null : `orc reply ${id} "<your answer>"`,
      button: act && el('div', { class: 'reply-row' }, input, Btn('reply', async () => {
        if (!input.value.trim()) return
        await act('reply', { taskId: id, text: input.value.trim() })
        toast('replied — step resuming', 'ok')
      }, 'warn')),
    }
  }
  switch (t.task.status) {
    case 'draft': {
      const model = el('input', {})
      model.value = 'anthropic/claude-haiku-4-5'
      return {
        text: 'no plan yet — propose one', tone: 'accent',
        cmd: act ? null : `orc propose ${id} --model anthropic/claude-haiku-4-5`,
        button: act && el('div', { class: 'reply-row' }, model, Btn('propose', async () => {
          await act('propose', { taskId: id, modelRef: model.value.trim() })
          toast('plan proposed', 'ok')
        })),
      }
    }
    case 'awaiting_approval': return {
      text: 'a plan is waiting for your approval — review the steps below', tone: 'warn',
      cmd: act ? null : `orc approve ${id}`,
      button: act && Btn('approve plan', async () => { await act('approve', { taskId: id }); toast('approved', 'ok') }, 'warn'),
    }
    case 'approved': {
      return {
        text: 'approved and ready — start the run', tone: 'accent',
        cmd: act ? null : `orc run ${id} --cwd .`,
        button: act && Btn('run', async () => {
          await act('run', { taskId: id, cwd: cwdInput.value.trim() })
          toast('run started', 'ok')
        }),
      }
    }
    case 'running': return { text: 'agents are working — watch the chat and log tabs', cmd: null, tone: 'accent', button: null }
    case 'blocked': return { text: 'blocked — check the newest chat messages for the open question', cmd: null, tone: 'warn', button: null }
    case 'done': return { text: `done — ${t.artifacts.length} verified artifact(s) below`, cmd: null, tone: 'ok', button: null }
    default: return null
  }
}

// module-level so the run button can read it; recreated per render
let cwdInput: HTMLInputElement = document.createElement('input')

// lifecycle rail: plan → approve → execute → done, with the current stage lit
const STAGES = ['plan', 'approve', 'execute', 'done'] as const
function stageIndex(status: string): number {
  switch (status) {
    case 'draft': return 0
    case 'awaiting_approval': return 1
    case 'done': return 3
    default: return 2
  }
}

function decomposition(ctx: RequestCtx): HTMLElement | null {
  if (ctx.planNotes.length === 0) return null
  const byId = new Map(ctx.planNotes.map(n => [n.id, n]))
  const children = (id: string): PlanNoteView[] =>
    byId.get(id)?.links.filter(l => l.kind === 'decomposes_into').map(l => byId.get(l.id)).filter((n): n is PlanNoteView => n !== undefined) ?? []
  const childIds = new Set(ctx.planNotes.flatMap(n => n.links.filter(l => l.kind === 'decomposes_into').map(l => l.id)))
  const roots = ctx.planNotes.filter(n => !childIds.has(n.id))
  const checked = new Set<string>()

  const noteRow = (n: PlanNoteView): HTMLElement => {
    const row = el('div', { class: 'tree-node' })
    const deps = n.links.filter(l => l.kind === 'depends_on')
    const head = el('div', { class: 'card-title' },
      Link(n.title, () => ctx.go(noteNodeId(ctx.planScopeName, n.id))),
      n.uncertainty.length ? Badge(`${n.uncertainty.length} uncertain`, 'warn') : null,
    )
    row.append(head, n.summary ? el('div', { class: 'muted' }, n.summary) : el('span', {}))
    if (deps.length) row.append(el('div', {}, 'after: ', ...deps.flatMap((d, i) => [i > 0 ? ', ' : '', Link(d.id, () => ctx.go(noteNodeId(ctx.planScopeName, d.id)))])))
    if (ctx.act) {
      const check = el('input', {}) as HTMLInputElement
      check.type = 'checkbox'
      check.onchange = () => { check.checked ? checked.add(n.id) : checked.delete(n.id) }
      const refine = el('input', {})
      refine.placeholder = 'refine this note…'
      row.append(el('div', { class: 'reply-row check-row' }, check, refine, Btn('annotate', async () => {
        if (!refine.value.trim()) return
        await ctx.act!('annotate', { taskId: ctx.taskId, noteId: n.id, text: refine.value.trim() })
        toast(`annotated ${n.id} — picked up on the next revise`, 'ok')
        refine.value = ''
      }, 'muted')))
    }
    for (const c of children(n.id)) row.append(noteRow(c))
    return row
  }

  const section = Card([`decomposition (${ctx.planNotes.length} plan notes)`,
    Btn(ctx.focused ? 'unfocus graph' : 'focus graph', () => ctx.onFocus(!ctx.focused), 'muted')])
  for (const r of roots) section.append(noteRow(r))
  if (ctx.act) {
    const text = el('input', {})
    text.placeholder = 'revision instruction for the checked notes…'
    section.append(el('div', { class: 'reply-row' }, text, Btn('revise checked notes', async () => {
      if (!text.value.trim() || checked.size === 0) { toast('check at least one note and write an instruction', 'warn'); return }
      await ctx.act!('revise', { taskId: ctx.taskId, text: text.value.trim(), scope: [...checked] })
      toast('revision queued — plan agent resuming', 'ok')
    }, 'warn')))
  }
  return section
}

export function renderRequest(ctx: RequestCtx): HTMLElement {
  const out = el('div', { class: 'road' })
  if (!ctx.t) return Empty('select a task')
  const t = ctx.t

  // 1) lifecycle rail
  const at = stageIndex(t.task.status)
  out.append(el('div', { class: 'rail' }, ...STAGES.flatMap((s, i) => [
    i > 0 ? el('span', { class: `rail-line${i <= at ? ' on' : ''}` }) : null,
    el('span', { class: `rail-stage${i === at ? ' now' : i < at ? ' past' : ''}` }, s),
  ])))

  // 2) your move (buttons when the server can act, chips otherwise)
  cwdInput = el('input', {})
  const move = yourMove(t, ctx.open, ctx.act)
  if (move) {
    const card = el('div', { class: `card move ${move.tone}` },
      el('div', { class: 'card-title' }, Badge('your move', move.tone), move.text))
    if (t.task.status === 'approved' && ctx.act) {
      cwdInput.value = ''
      cwdInput.placeholder = 'working directory for the run'
      card.append(el('label', { class: 'field' }, el('span', {}, 'cwd'), cwdInput))
    }
    if (move.button) card.append(move.button)
    else if (move.cmd) card.append(cmdChip(move.cmd))
    out.append(card)
  }

  // 3) decomposition (grounded requests) with refine controls
  const deco = decomposition(ctx)
  if (deco) out.append(deco)

  // 4) the road of steps (approved plan by default, any version viewable)
  if (ctx.plans && ctx.plans.versions.length > 0) {
    const plans = ctx.plans
    const active = ctx.shownVersion ?? plans.approvedVersion ?? plans.versions.at(-1)!.version
    const plan = plans.versions.find(v => v.version === active) ?? plans.versions.at(-1)!
    out.append(Tabs(
      plans.versions.map(v => ({ id: String(v.version), label: `v${v.version}${v.version === plans.approvedVersion ? ' ✓' : ''}` })),
      String(active),
      id => ctx.showVersion(Number(id)),
    ))
    if (active !== plans.approvedVersion) out.append(el('div', { class: 'empty' }, 'not the approved version'))
    const runOf = new Map(t.steps.map(s => [s.stepId, s]))
    for (const s of topoOrder(plan.steps)) {
      const run = runOf.get(s.id)
      const status = run?.status ?? 'pending'
      out.append(el('div', { class: 'road-step' },
        el('div', { class: 'road-marker' }, Dot(status === 'completed' ? 'step' : 'task')),
        Card(
          [Link(s.title, () => ctx.go(stepNodeId(ctx.taskId, s.id))), Badge(status, statusTone(status)),
            run ? Badge(`${run.iterations}/${s.maxIterations} iter`, 'muted') : null].filter((x): x is NonNullable<typeof x> => x !== null),
          KV([
            ['role', s.role],
            ['model', s.modelRef],
            ...(s.dependsOn.length ? [['after', el('span', {}, ...s.dependsOn.flatMap((d, i) => [i > 0 ? ', ' : '', Link(d, () => ctx.go(stepNodeId(ctx.taskId, d)))]))] as [string, HTMLElement]] : []),
          ]),
          el('details', {}, el('summary', { class: 'muted' }, 'instructions'), Pre(s.instructions)),
        ),
      ))
    }
  } else if (ctx.planNotes.length === 0) {
    out.append(Empty('no plan proposed yet'))
  }

  // 5) knowledge this request grew
  if (ctx.knowledge.length) out.append(Card([`knowledge (${ctx.knowledge.length} notes)`],
    KV(ctx.knowledge.map(n => ['', el('span', {}, Link(n.label, () => ctx.go(n.id)), ' ', Badge(n.detail, 'purple'))] as [string, HTMLElement]))))

  // 6) destination: verified outputs
  if (t.artifacts.length) out.append(Card([`outputs (${t.artifacts.length})`],
    KV(t.artifacts.map(a => ['', el('span', {}, Link(a.path, () => ctx.go(`artifact:${ctx.taskId}:${a.path}`)), ` · ${a.size}B`)] as [string, HTMLElement]))))
  return out
}
