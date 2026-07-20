// Plan tab — the ROAD view: where this request stands (lifecycle rail), the steps in execution
// order with live status, and a "your move" callout with the exact next command. Composed from
// ui/ primitives; version tabs keep every proposed plan reachable (approved is the default).
import { stepNodeId } from '@orc/ui-core/graph' // browser-safe subpath — never the ui-core index
import { el } from './ui/el'
import { Badge, Card, Dot, Empty, KV, Link, Pre, Tabs, statusTone } from './ui/components'

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

const cmdChip = (cmd: string): HTMLElement => {
  const chip = el('code', { class: 'cmd', title: 'click to copy', onClick: () => void navigator.clipboard.writeText(cmd) }, cmd)
  return chip
}

// the single "what should the human do now" decision — precedence: failure > question > gates
function yourMove(t: TaskView, open: OpenQuestion[]): { text: string; cmd: string | null; tone: 'danger' | 'warn' | 'accent' | 'ok' } | null {
  const failed = t.steps.find(s => s.status === 'failed')
  if (failed) return { text: `step '${failed.stepId}' failed — inspect its chat, then retry`, cmd: `orc retry ${t.task.id}`, tone: 'danger' }
  if (open.length > 0) return { text: `the agent is asking: “${open[0]!.question}”`, cmd: `orc reply ${t.task.id} "<your answer>"`, tone: 'warn' }
  switch (t.task.status) {
    case 'draft': return { text: 'no plan yet — propose one', cmd: `orc propose ${t.task.id} --model anthropic/claude-haiku-4-5`, tone: 'accent' }
    case 'awaiting_approval': return { text: 'a plan is waiting for your approval — review the steps below', cmd: `orc approve ${t.task.id}`, tone: 'warn' }
    case 'approved': return { text: 'approved and ready — start the run', cmd: `orc run ${t.task.id} --cwd .`, tone: 'accent' }
    case 'running': return { text: 'agents are working — watch the chat and log tabs', cmd: null, tone: 'accent' }
    case 'blocked': return { text: 'blocked — check the newest chat messages for the open question', cmd: null, tone: 'warn' }
    case 'done': return { text: `done — ${t.artifacts.length} verified artifact(s) below`, cmd: null, tone: 'ok' }
    default: return null
  }
}

// lifecycle rail: plan → approve → execute → done, with the current stage lit
const STAGES = ['plan', 'approve', 'execute', 'done'] as const
function stageIndex(status: string): number {
  switch (status) {
    case 'draft': return 0
    case 'awaiting_approval': return 1
    case 'approved': return 2
    case 'running': case 'blocked': return 2
    case 'done': return 3
    default: return 2 // cancelled/failed sit at execute
  }
}

export function renderRoad(
  taskId: string,
  plans: PlansView | null,
  t: TaskView | null,
  open: OpenQuestion[],
  shownVersion: number | null,
  go: (node: string) => void,
  showVersion: (v: number) => void,
): HTMLElement {
  const out = el('div', { class: 'road' })
  if (!t) return Empty('select a task')

  // 1) lifecycle rail
  const at = stageIndex(t.task.status)
  out.append(el('div', { class: 'rail' }, ...STAGES.flatMap((s, i) => [
    i > 0 ? el('span', { class: `rail-line${i <= at ? ' on' : ''}` }) : null,
    el('span', { class: `rail-stage${i === at ? ' now' : i < at ? ' past' : ''}` }, s),
  ])))

  // 2) your move
  const move = yourMove(t, open)
  if (move) out.append(el('div', { class: `card move ${move.tone}` },
    el('div', { class: 'card-title' }, Badge('your move', move.tone), move.text),
    move.cmd ? cmdChip(move.cmd) : null,
  ))

  // 3) the road of steps (approved plan by default, any version viewable)
  if (!plans || plans.versions.length === 0) { out.append(Empty('no plan proposed yet')); return out }
  const active = shownVersion ?? plans.approvedVersion ?? plans.versions.at(-1)!.version
  const plan = plans.versions.find(v => v.version === active) ?? plans.versions.at(-1)!
  out.append(Tabs(
    plans.versions.map(v => ({ id: String(v.version), label: `v${v.version}${v.version === plans.approvedVersion ? ' ✓' : ''}` })),
    String(active),
    id => showVersion(Number(id)),
  ))
  if (active !== plans.approvedVersion) out.append(el('div', { class: 'empty' }, 'not the approved version'))

  const runOf = new Map(t.steps.map(s => [s.stepId, s]))
  for (const s of topoOrder(plan.steps)) {
    const run = runOf.get(s.id)
    const status = run?.status ?? 'pending'
    out.append(el('div', { class: 'road-step' },
      el('div', { class: 'road-marker' }, Dot(status === 'completed' ? 'step' : status === 'failed' ? '' : 'task')),
      Card(
        [Link(s.title, () => go(stepNodeId(taskId, s.id))), Badge(status, statusTone(status)), run ? Badge(`${run.iterations}/${s.maxIterations} iter`, 'muted') : null].filter((x): x is NonNullable<typeof x> => x !== null),
        KV([
          ['role', s.role],
          ['model', s.modelRef],
          ...(s.dependsOn.length ? [['after', el('span', {}, ...s.dependsOn.flatMap((d, i) => [i > 0 ? ', ' : '', Link(d, () => go(stepNodeId(taskId, d)))]))] as [string, HTMLElement]] : []),
        ]),
        el('details', {}, el('summary', { class: 'muted' }, 'instructions'), Pre(s.instructions)),
      ),
    ))
  }

  // 4) destination: verified outputs
  if (t.artifacts.length) out.append(Card([`outputs (${t.artifacts.length})`],
    KV(t.artifacts.map(a => ['', el('span', {}, Link(a.path, () => go(`artifact:${taskId}:${a.path}`)), ` · ${a.size}B`)] as [string, HTMLElement]))))
  return out
}
