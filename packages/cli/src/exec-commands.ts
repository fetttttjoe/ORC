import { Command } from 'commander'
import { EventKind, type TaskNode } from '@orc/contracts'
import { fold, gatedChildren, orphanTasks, stepUsage, taskUsage, tasksByWorkspace } from '@orc/kernel'
import { enumArg } from './enum-arg'
import { parseNonNegativeInteger } from './int-arg'
import { CommandFailure, EXIT_CODE } from './exit'
import { knowledgeHealthLine } from './knowledge-health-line'
import { knowledgeHealthOf } from './knowledge-health-of'
import { CLI_ORIGIN, type ProgramDeps } from './program-deps'
import { untilInterrupted } from './until-interrupted'
import { formatUsageLine } from './usage-render'
import { watchStream } from './stream-watch'

export function execCommands(deps: Pick<ProgramDeps, 'actions' | 'requireKernel' | 'requireTask' | 'watchFrom'>): Command[] {
  const { actions, requireKernel, requireTask, watchFrom } = deps
  const group = new Command()
  const taskLine = (t: TaskNode): string => `  ${t.id}  ${t.status.padEnd(17)} ${t.title}`

  group
    .command('tasks')
    .description('list tasks')
    .action(async () => {
      const state = await requireKernel().state()
      const groups = tasksByWorkspace(state)
      const orphans = orphanTasks(state)
      if (groups.every(g => g.tasks.length === 0) && orphans.length === 0) {
        console.log('_no tasks_')
        return
      }
      for (const g of groups) {
        console.log(`# ${g.workspace.title}  (${g.workspace.branch ?? 'detached'})  ${g.workspace.cwd}`)
        for (const t of g.tasks) console.log(taskLine(t))
      }
      // a task naming an unseen workspace is a log defect: surfaced loudly, not dropped from the view
      if (orphans.length > 0) {
        console.log('# ORPHANED — workspace missing from the log')
        for (const t of orphans) console.log(taskLine(t))
      }
    })

  group
    .command('log <taskId>')
    .description('show the event trail for a task')
    .option('--json', 'full redacted event records as JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      await requireTask(taskId)
      const events = await requireKernel().eventsFor(taskId)
      if (opts.json) {
        console.log(JSON.stringify(events, null, 2))
        return
      }
      for (const e of events)
        console.log(`${String(e.seq).padStart(4)}  ${e.ts}  ${e.kind}`)
    })

  group
    .command('replay <taskId>')
    .description('read-only audit replay: folded state at an event sequence (default: latest)')
    .option('--at <seq>', "replay up to and including this GLOBAL event sequence — sequences span the whole project log, not one task; see 'orc log <taskId>' for the task's range", parseNonNegativeInteger)
    .action(async (taskId: string, opts: { at?: number }) => {
      await requireTask(taskId)
      const all = await requireKernel().eventsFor(taskId)
      const at = opts.at ?? Number.POSITIVE_INFINITY
      const events = all.filter(e => e.seq <= at)
      const [first] = all
      const last = all.at(-1)
      if (events.length === 0 && first && last) {
        // an empty fold here is a footgun, not data: --at is below this task's first event
        console.error(`no events for '${taskId}' at or before seq ${opts.at} — sequences are GLOBAL across the project log; this task's events span ${first.seq}..${last.seq} (orc log ${taskId})`)
        throw new CommandFailure(EXIT_CODE.failure) // already reported above — the entry point only sets the code
      }
      const state = fold(events)
      console.log(JSON.stringify(
        state,
        (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value),
        2,
      ))
    })

  group
    .command('watch')
    .description("follow the project's whole event log live — one line per event (seq, kind, summary) — until interrupted")
    .option('--since <seq>', 'only events after this sequence (default: a live tail from now, nothing replayed)', parseNonNegativeInteger)
    .option('--kind <kind...>', `only these event kinds (repeatable): ${Object.values(EventKind).join(', ')}`)
    .action(async (opts: { since?: number; kind?: string[] }) => {
      const kinds = opts.kind?.map(k => enumArg<EventKind>('--kind', Object.values(EventKind))(k))
      const unsubscribe = await watchStream(requireKernel(), { since: opts.since, kinds }, line => console.log(line))
      await untilInterrupted()
      await unsubscribe()
    })
  const CWD_OVERRIDE_HELP = "override the working directory (default: the task's workspace)"

  group
    .command('run <taskId>')
    .description('execute the approved plan (durable; the supervisor drives it, re-running attaches)')
    .option('--cwd <dir>', CWD_OVERRIDE_HELP)
    .action(async (taskId: string, opts: { cwd?: string }) => {
      const { since } = await actions().run(taskId, opts.cwd ?? null, CLI_ORIGIN)
      await watchFrom(taskId, since)
    })

  group
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>', CWD_OVERRIDE_HELP)
    .action(async (taskId: string, opts: { cwd?: string }) => {
      const { since } = await actions().retry(taskId, opts.cwd ?? null, CLI_ORIGIN)
      await watchFrom(taskId, since)
    })

  group
    .command('cancel <taskId>')
    .description('cancel the active run; the task becomes cancelled (terminal)')
    .action(async (taskId: string) => {
      await actions().cancel(taskId, CLI_ORIGIN)
      console.log('cancelled')
    })
  return [...group.commands]
}

export function statusCommand(deps: Pick<ProgramDeps, 'requireKernel' | 'plugin' | 'derivedPlanFor'>): Command {
  const { requireKernel, plugin, derivedPlanFor } = deps
  return new Command('status')
    .argument('<taskId>')
    .description('per-step state and cost totals')
    .action(async (taskId: string) => {
      const state = await requireKernel().state()
      const task = state.tasks.get(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      if (plugin) {
        console.log(`project: ${plugin.config.projectName} (${plugin.config.projectId})`)
        console.log(knowledgeHealthLine(await knowledgeHealthOf(plugin, requireKernel())))
      }
      console.log(`${task.id}  ${task.status}  ${task.title}`)
      const plan = state.plans.get(taskId)?.versions.at(-1)
      for (const step of plan?.steps ?? []) {
        const s = state.steps.get(taskId)?.get(step.id)
        const status = s?.status ?? 'pending'
        const detail = s?.failure ? `  [${s.failure.class}] ${s.failure.message}` : (s?.output ? `  → ${s.output}` : '')
        console.log(`  ${step.id.padEnd(12)} ${status.padEnd(10)} attempt ${s?.attempt ?? 0}${detail}`)
        console.log(`    ${formatUsageLine(stepUsage(state, taskId, step.id))}`)
      }
      // a grounded task shows what its analysis covered and the gaps it did not
      const coverage = await requireKernel().latestCoverage(taskId)
      if (coverage)
        console.log(`  analysis: ${coverage.analyzed ? `${coverage.claimsWritten} claims, confidence ${coverage.confidence}` : 'not analyzed'}${coverage.gaps.length ? `  gaps: ${coverage.gaps.join(', ')}` : ''}`)
      // a grounded-plan step parked on ask_human shows its question, not just a blind reply target
      const feedback = await requireKernel().openFeedback(taskId)
      if (feedback) {
        console.log(`  awaiting reply: ${feedback.question}  (orc reply ${taskId} <text>)`)
        const derived = await derivedPlanFor(taskId)
        for (const line of derived ? derived.split('\n') : []) console.log(`  ${line}`)
      }
      // printed last and unconditionally: a failed reaction otherwise reads at the terminal as a hang
      for (const f of state.reactionFailures.get(taskId) ?? [])
        console.log(`  runtime could not ${f.reaction}${f.causeSeq === null ? '' : ` (seq ${f.causeSeq})`}: ${f.message}`)
      // the other human gate: a manual-policy split, which join_splits waits on as durably
      for (const child of gatedChildren(state, taskId))
        console.log(`  awaiting approval: ${child.title}  (orc approve ${child.id})`)
      const ops = [...state.operations.values()]
        .filter(o => o.taskId === taskId)
        .sort((a, b) => a.startedSeq - b.startedSeq)
      for (const o of ops)
        console.log(`  op  ${o.kind.padEnd(6)} ${o.name.padEnd(24)} ${o.status.padEnd(10)} attempts ${o.attempts}`)
      for (const a of state.artifacts.get(taskId) ?? [])
        console.log(`  out ${(a.stepId ?? '?').padEnd(12)} ${a.path} · sha256:${a.sha256.slice(0, 12)}… · ${a.size}B`)
      console.log(`  ${formatUsageLine(taskUsage(state, taskId))}`)
    })
}
