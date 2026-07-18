import { z } from 'zod'
import { EVENT_KIND, OPERATION_STATUS, PAYLOAD_SCHEMAS, STEP_RUN_STATUS, TASK_STATUS, type EventRecord, type Plan, type TaskNode } from '@orc/contracts'
import { fold, taskUsage, type State, type StepState } from '@orc/kernel'
import { frontmatter } from './frontmatter'
import { renderPlanFile } from './plan-md'

export type VaultFiles = Record<string, string>

const fm = (obj: Record<string, unknown>, body: string): string => `${frontmatter(obj)}\n${body}\n`
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

const statusClass = (s: StepState | undefined): 'done' | 'running' | 'failed' | 'pending' =>
  !s ? 'pending'
    : s.status === STEP_RUN_STATUS.completed ? 'done'
    : s.status === STEP_RUN_STATUS.failed ? 'failed'
    : 'running'

function mermaidDag(plan: Plan, steps: Map<string, StepState> | undefined): string {
  const lines = ['```mermaid', 'graph TD']
  for (const st of plan.steps) {
    const s = steps?.get(st.id)
    const iter = s && s.status === STEP_RUN_STATUS.running ? ` · iter ${s.iterations}` : ''
    lines.push(`  ${st.id}["${st.id} · ${st.executorRef} · ${st.modelRef}${iter}"]:::${statusClass(s)}`)
  }
  for (const st of plan.steps) for (const d of st.dependsOn) lines.push(`  ${d} --> ${st.id}`)
  lines.push('  classDef done fill:#1a7f37,color:#fff')
  lines.push('  classDef running fill:#bf8700,color:#fff')
  lines.push('  classDef failed fill:#cf222e,color:#fff')
  lines.push('  classDef pending fill:#6e7781,color:#fff')
  lines.push('```')
  return lines.join('\n')
}

// mermaid labels: double quotes end the label — never let data break the graph.
// Exported: every mermaid-producing view (incl. plugins/memory's index) must share one escaper.
export const mermaidLabel = (s: string): string => s.replaceAll('"', "'")
const label = mermaidLabel

// Plan topology plus live operation nodes: which effects ran, how many attempts, and
// whether any node is still unresolved (started with no completion — the honest gap).
function renderExecution(task: TaskNode, plan: Plan | undefined, state: State): string {
  const head = { type: 'execution', task: task.id }
  if (!plan) return fm(head, `# Execution: ${task.title}\n\n_no plan yet_`)
  const steps = state.steps.get(task.id)
  const lines = ['```mermaid', 'graph TD']
  for (const st of plan.steps) lines.push(`  ${st.id}["${label(`${st.id} · ${st.executorRef}`)}"]:::${statusClass(steps?.get(st.id))}`)
  for (const st of plan.steps) for (const d of st.dependsOn) lines.push(`  ${d} --> ${st.id}`)
  const ops = [...state.operations.values()]
    .filter(o => o.taskId === task.id)
    .sort((a, b) => a.startedSeq - b.startedSeq)
  ops.forEach((o, i) => {
    const cls = o.status === OPERATION_STATUS.completed ? 'done' : o.status === OPERATION_STATUS.failed ? 'failed' : 'unresolved'
    lines.push(`  op${i}["${label(`${o.kind} ${o.name} · ${o.status} · attempts ${o.attempts}`)}"]:::${cls}`)
    lines.push(`  ${o.stepId} --> op${i}`)
  })
  lines.push('  classDef done fill:#1a7f37,color:#fff')
  lines.push('  classDef running fill:#bf8700,color:#fff')
  lines.push('  classDef failed fill:#cf222e,color:#fff')
  lines.push('  classDef pending fill:#6e7781,color:#fff')
  lines.push('  classDef unresolved fill:#bf8700,color:#fff,stroke-dasharray: 5 5') // visually distinct: attempt began, outcome unknown
  lines.push('```')
  return fm(head, `# Execution: ${task.title}\n\n${lines.join('\n')}`)
}

// producing step → verified output receipt
function renderLineage(task: TaskNode, state: State): string {
  const head = { type: 'lineage', task: task.id }
  const artifacts = state.artifacts.get(task.id) ?? []
  if (artifacts.length === 0) return fm(head, `# Lineage: ${task.title}\n\n_no declared outputs_`)
  const lines = ['```mermaid', 'graph LR']
  const steps = [...new Set(artifacts.map(a => a.stepId ?? 'unknown'))]
  for (const s of steps) lines.push(`  ${s}["${label(s)}"]`)
  artifacts.forEach((a, i) => {
    lines.push(`  art${i}["${label(`${a.path} · sha256:${a.sha256.slice(0, 12)} · ${a.size}B`)}"]`)
    lines.push(`  ${a.stepId ?? 'unknown'} --> art${i}`)
  })
  lines.push('```')
  return fm(head, `# Lineage: ${task.title}\n\n${lines.join('\n')}`)
}

function renderTaskIndex(task: TaskNode, plan: Plan | undefined, steps: Map<string, StepState> | undefined, state: State): string {
  const links = [
    plan ? `- [Plan v${plan.version}](plan-v${plan.version}.md)` : '',
    '- [Log](log.md)',
    '- [Execution](execution.md)',
    '- [Lineage](lineage.md)',
    ...(plan?.steps ?? []).map(s => `- [Session: ${s.id}](sessions/${s.id}.md)`),
  ].filter(Boolean).join('\n')
  const dag = plan ? mermaidDag(plan, steps) : '_no plan yet_'
  const u = taskUsage(state, task.id)
  return fm(
    { type: 'task', id: task.id, title: task.title, status: task.status, parent: task.parentId, depth: task.depth, budgetUSD: task.budgetUSD },
    `# ${task.title}\n\n${task.spec || '_no spec_'}\n\n## Working graph\n\n${dag}\n\n## Artifacts\n\n${links}\n\n_tokens in/out: ${u.inputTokens}/${u.outputTokens}_`,
  )
}

function renderLog(events: EventRecord[]): string {
  const rows = [...events].reverse()
    .map(e => `- \`${String(e.seq).padStart(4)}\` ${e.ts} · **${e.kind}**${e.stepId ? ` · ${e.stepId}` : ''}`)
    .join('\n')
  return fm({ type: 'log' }, `# Log\n\n${rows || '_empty_'}`)
}

// lenient reads: a malformed historical payload renders as a gap, never a crash
const AgentCallView = z.object({ iteration: z.number(), response: z.object({ text: z.string().optional() }).optional() })

function renderSession(stepId: string, events: EventRecord[], step: StepState | undefined): string {
  const parts: string[] = []
  for (const e of events) {
    if (e.kind === EVENT_KIND.agent_call) {
      const p = AgentCallView.safeParse(e.payload)
      if (p.success) parts.push(`### Iteration ${p.data.iteration}\n\n${p.data.response?.text || '_(tool-only turn)_'}`)
    } else if (e.kind === EVENT_KIND.tool_call) {
      const p = PAYLOAD_SCHEMAS.tool_call.safeParse(e.payload)
      if (p.success) parts.push(`- 🔧 **${p.data.toolName}** \`${truncate(JSON.stringify(p.data.input), 200)}\``)
    } else if (e.kind === EVENT_KIND.tool_result) {
      const p = PAYLOAD_SCHEMAS.tool_result.safeParse(e.payload)
      if (p.success) parts.push(`  ↳ ${p.data.isError ? '❌' : '✓'} \`${truncate(JSON.stringify(p.data.output), 200)}\``)
    } else if (e.kind === EVENT_KIND.signal_received) {
      const p = PAYLOAD_SCHEMAS.signal_received.safeParse(e.payload)
      if (p.success) parts.push(`### Signal: ${p.data.signal.outcome}\n\n${p.data.signal.summary}`)
    }
  }
  return fm({ type: 'session', step: stepId, status: step?.status ?? 'pending' }, `# Session: ${stepId}\n\n${parts.join('\n') || '_no activity yet_'}`)
}

export function renderTaskFiles(taskId: string, events: EventRecord[]): VaultFiles {
  const state = fold(events)
  const task = state.tasks.get(taskId)
  if (!task) return {}
  const base = `tasks/${taskId}`
  const plans = state.plans.get(taskId)
  const steps = state.steps.get(taskId)
  const files: VaultFiles = {
    [`${base}/index.md`]: renderTaskIndex(task, plans?.versions.at(-1), steps, state),
    [`${base}/log.md`]: renderLog(events),
    [`${base}/execution.md`]: renderExecution(task, plans?.versions.at(-1), state),
    [`${base}/lineage.md`]: renderLineage(task, state),
  }
  for (const p of plans?.versions ?? []) files[`${base}/plan-v${p.version}.md`] = renderPlanFile(p)
  const byStep = new Map<string, EventRecord[]>()
  for (const e of events) if (e.stepId) { const a = byStep.get(e.stepId) ?? []; a.push(e); byStep.set(e.stepId, a) }
  for (const [stepId, evs] of byStep) files[`${base}/sessions/${stepId}.md`] = renderSession(stepId, evs, steps?.get(stepId))
  return files
}

// deterministic recursive task-expansion graph: which task created which child, with live status
function taskExpansionGraph(tasks: TaskNode[]): string {
  if (tasks.length === 0) return '_no tasks_'
  const node = new Map(tasks.map((t, i) => [t.id, `t${i}`]))
  const lines = ['```mermaid', 'graph TD']
  for (const t of tasks) lines.push(`  ${node.get(t.id)}["${label(`${t.title} · ${t.status}`)}"]`)
  for (const t of tasks)
    if (t.parentId && node.has(t.parentId)) lines.push(`  ${node.get(t.parentId)} --> ${node.get(t.id)}`)
  lines.push('```')
  return lines.join('\n')
}

export function renderRootIndex(tasks: TaskNode[]): string {
  // one deterministic order for every section — the render must not depend on input order
  const sorted = [...tasks].sort((a, b) =>
    a.depth - b.depth || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const link = (t: TaskNode, suffix: string): string => `- [${t.title}](tasks/${t.id}/index.md) — ${suffix}`
  const running = sorted.filter(t => t.status === TASK_STATUS.running)
  const active = running.length ? running.map(t => link(t, 'running')).join('\n') : '_none_'
  const all = sorted.length ? sorted.map(t => link(t, t.status)).join('\n') : '_no tasks_'
  return fm(
    { type: 'index' },
    `# Vault\n\n## Task expansion\n\n${taskExpansionGraph(sorted)}\n\n## Active runs\n\n${active}\n\n## All tasks\n\n${all}`,
  )
}
