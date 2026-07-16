import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { ISOLATION_TIER, PlanDraft } from '@orc/contracts'
import { EventLog, Kernel } from '@orc/kernel'

export function openKernel(dir: string = process.cwd()): Kernel {
  const dbDir = path.join(dir, '.orc')
  mkdirSync(dbDir, { recursive: true })
  return new Kernel(new EventLog(path.join(dbDir, 'state.db')))
}

export function singleStepDraft(task: { title: string; spec: string }, modelRef: string): PlanDraft {
  return {
    strategyRef: 'template:single',
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role: 'worker',
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs: [],
      isolation: ISOLATION_TIER.worktree,
      zone: [],
      maxIterations: 25,
      dependsOn: [],
    }],
  }
}

function resolveDraft(task: { title: string; spec: string }, opts: { file?: string; model: string }): PlanDraft {
  return opts.file
    ? PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8')))
    : singleStepDraft(task, opts.model)
}

export function buildProgram(kernel: Kernel): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')

  program
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .action((title: string, opts: { spec: string; parent?: string }) => {
      const t = kernel.createTask({ title, spec: opts.spec, parentId: opts.parent })
      console.log(t.id)
    })

  program
    .command('propose <taskId>')
    .description('propose a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .action((taskId: string, opts: { file?: string; model: string }) => {
      const task = kernel.getTask(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      const draft = resolveDraft(task, opts)
      const plan = kernel.proposePlan(taskId, draft)
      console.log(`plan v${plan.version} proposed (${plan.steps.length} steps) — review with: orc plan ${taskId}`)
    })

  program
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .action((taskId: string, opts: { file?: string; model: string }) => {
      const task = kernel.getTask(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      const draft = resolveDraft(task, opts)
      const plan = kernel.editPlan(taskId, draft)
      console.log(`plan v${plan.version} edited — review with: orc plan ${taskId}`)
    })

  program
    .command('plan <taskId>')
    .description('show a plan (latest by default)')
    .option('--version <n>', 'plan version')
    .action((taskId: string, opts: { version?: string }) => {
      const plan = kernel.getPlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      if (!plan) throw new Error(`no plan for task '${taskId}'`)
      console.log(JSON.stringify(plan, null, 2))
    })

  program
    .command('approve <taskId>')
    .description('approve the latest plan (the human gate)')
    .option('--version <n>', 'expected version (fails if stale)')
    .action((taskId: string, opts: { version?: string }) => {
      const plan = kernel.approvePlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      console.log(`plan v${plan.version} approved`)
    })

  program
    .command('tasks')
    .description('list tasks')
    .action(() => {
      for (const t of kernel.listTasks())
        console.log(`${t.id}  ${t.status.padEnd(17)} ${t.title}`)
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .action((taskId: string) => {
      for (const e of kernel.eventsFor(taskId))
        console.log(`${String(e.seq).padStart(4)}  ${e.ts}  ${e.kind}`)
    })

  return program
}
