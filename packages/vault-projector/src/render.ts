import { EVENT_KIND, STEP_RUN_STATUS, TASK_STATUS, type EventRecord, type Plan, type TaskNode } from '@orc/contracts'
import { fold, taskUsage, type State, type StepState } from '@orc/kernel'
import { renderPlanFile } from './plan-md'

export type VaultFiles = Record<string, string>

const fm = (obj: Record<string, unknown>, body: string): string =>
  `---\n${Bun.YAML.stringify(obj, null, 2).trimEnd()}\n---\n\n${body}\n`
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

function renderTaskIndex(task: TaskNode, plan: Plan | undefined, steps: Map<string, StepState> | undefined, state: State): string {
  const links = [
    plan ? `- [Plan v${plan.version}](plan-v${plan.version}.md)` : '',
    '- [Log](log.md)',
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

function renderSession(stepId: string, events: EventRecord[], step: StepState | undefined): string {
  const parts: string[] = []
  for (const e of events) {
    const p = e.payload as Record<string, any>
    if (e.kind === EVENT_KIND.agent_call) parts.push(`### Iteration ${p.iteration}\n\n${p.response?.text || '_(tool-only turn)_'}`)
    else if (e.kind === EVENT_KIND.tool_call) parts.push(`- 🔧 **${p.toolName}** \`${truncate(JSON.stringify(p.input), 200)}\``)
    else if (e.kind === EVENT_KIND.tool_result) parts.push(`  ↳ ${p.isError ? '❌' : '✓'} \`${truncate(JSON.stringify(p.output), 200)}\``)
    else if (e.kind === EVENT_KIND.signal_received) parts.push(`### Signal: ${p.signal.outcome}\n\n${p.signal.summary}`)
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
  }
  for (const p of plans?.versions ?? []) files[`${base}/plan-v${p.version}.md`] = renderPlanFile(p, task.status)
  const byStep = new Map<string, EventRecord[]>()
  for (const e of events) if (e.stepId) { const a = byStep.get(e.stepId) ?? []; a.push(e); byStep.set(e.stepId, a) }
  for (const [stepId, evs] of byStep) files[`${base}/sessions/${stepId}.md`] = renderSession(stepId, evs, steps?.get(stepId))
  return files
}

export function renderRootIndex(tasks: TaskNode[]): string {
  const link = (t: TaskNode, suffix: string): string => `- [${t.title}](tasks/${t.id}/index.md) — ${suffix}`
  const running = tasks.filter(t => t.status === TASK_STATUS.running)
  const active = running.length ? running.map(t => link(t, 'running')).join('\n') : '_none_'
  const all = tasks.length ? tasks.map(t => link(t, t.status)).join('\n') : '_no tasks_'
  return fm({ type: 'index' }, `# Vault\n\n## Active runs\n\n${active}\n\n## All tasks\n\n${all}`)
}
