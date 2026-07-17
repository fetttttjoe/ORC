import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { ISOLATION_TIER, PlanDraft, type ExecutionPort, type Plan, type RunHandle } from '@orc/contracts'
import { EventLog, Kernel, loadConfig, taskUsage } from '@orc/kernel'

// loadConfig is the ONE resolution of env → .orc/config.json → default; every command
// (read-only or executing) must land on the same database
export async function openKernel(url = loadConfig().databaseUrl): Promise<Kernel> {
  return new Kernel(await EventLog.open(url))
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
      toolRefs: [],
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

// ponytail: 500ms poll on the events table for live tailing — LISTEN/NOTIFY when it matters
async function tailUntilDone(kernel: Kernel, taskId: string, handle: RunHandle): Promise<string> {
  let lastSeq = Math.max(0, ...(await kernel.eventsFor(taskId)).map(e => e.seq))
  let done = false
  const outcomeP = handle.wait().finally(() => { done = true })
  outcomeP.catch(() => {}) // attach a handler now so polling below can't trip an unhandled-rejection; real rejection still propagates via the return
  const printFresh = async () => {
    // delta query — late in a run the full history is megabytes of agent_call payloads
    for (const e of await kernel.eventsSince(taskId, lastSeq)) {
      lastSeq = e.seq
      console.log(`${String(e.seq).padStart(4)}  ${e.kind}${e.stepId ? `  ${e.stepId}` : ''}`)
    }
  }
  while (!done) {
    await new Promise(r => setTimeout(r, 500))
    await printFresh()
  }
  await printFresh() // drain events written in the final ≤500ms window before wait() settled
  return outcomeP
}

export function buildProgram(kernel: Kernel, portFactory?: () => Promise<ExecutionPort>): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')

  program
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .action(async (title: string, opts: { spec: string; parent?: string }) => {
      const t = await kernel.createTask({ title, spec: opts.spec, parentId: opts.parent })
      console.log(t.id)
    })

  const planAction = (apply: (taskId: string, draft: PlanDraft) => Promise<Plan>, describe: (plan: Plan) => string) =>
    async (taskId: string, opts: { file?: string; model: string }) => {
      const task = await kernel.getTask(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      const plan = await apply(taskId, resolveDraft(task, opts))
      console.log(`plan v${plan.version} ${describe(plan)} — review with: orc plan ${taskId}`)
    }

  program
    .command('propose <taskId>')
    .description('propose a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .action(planAction((id, draft) => kernel.proposePlan(id, draft), plan => `proposed (${plan.steps.length} steps)`))

  program
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .action(planAction((id, draft) => kernel.editPlan(id, draft), () => 'edited'))

  program
    .command('plan <taskId>')
    .description('show a plan (latest by default)')
    .option('--version <n>', 'plan version')
    .action(async (taskId: string, opts: { version?: string }) => {
      const plan = await kernel.getPlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      if (!plan) throw new Error(`no plan for task '${taskId}'`)
      console.log(JSON.stringify(plan, null, 2))
    })

  program
    .command('approve <taskId>')
    .description('approve the latest plan (the human gate)')
    .option('--version <n>', 'expected version (fails if stale)')
    .action(async (taskId: string, opts: { version?: string }) => {
      const plan = await kernel.approvePlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      console.log(`plan v${plan.version} approved`)
    })

  program
    .command('tasks')
    .description('list tasks')
    .action(async () => {
      for (const t of await kernel.listTasks())
        console.log(`${t.id}  ${t.status.padEnd(17)} ${t.title}`)
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .action(async (taskId: string) => {
      for (const e of await kernel.eventsFor(taskId))
        console.log(`${String(e.seq).padStart(4)}  ${e.ts}  ${e.kind}`)
    })

  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw new Error('execution commands are unavailable in this context')
    return portFactory()
  }

  const execAction = (start: (port: ExecutionPort, taskId: string, cwd?: string) => Promise<RunHandle>, intro: (h: RunHandle, taskId: string) => string) =>
    async (taskId: string, opts: { cwd?: string }) => {
      const handle = await start(await needPort(), taskId, opts.cwd)
      console.log(intro(handle, taskId))
      const outcome = await tailUntilDone(kernel, taskId, handle)
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === 'done' ? 0 : 1
    }

  program
    .command('run <taskId>')
    .description('execute the approved plan (durable; re-run attaches/resumes)')
    .option('--cwd <dir>', 'shared workspace for all steps (default: per-step .orc/workspaces/)')
    .action(execAction(
      (port, taskId, cwd) => port.startRun(taskId, { cwd }),
      (h, taskId) => `run ${h.workflowId} started — tailing events (ctrl-c stops the run; re-run orc run ${taskId} to resume)`,
    ))

  program
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>')
    .action(execAction(
      (port, taskId, cwd) => port.retry(taskId, { cwd }),
      h => `retry ${h.workflowId} started`,
    ))

  program
    .command('cancel <taskId>')
    .description('cancel the active run (terminal in M2)')
    .action(async (taskId: string) => {
      await (await needPort()).cancelRun(taskId)
      console.log('cancelled')
    })

  program
    .command('status <taskId>')
    .description('per-step state and cost totals')
    .action(async (taskId: string) => {
      const state = await kernel.state()
      const task = state.tasks.get(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      console.log(`${task.id}  ${task.status}  ${task.title}`)
      const plan = state.plans.get(taskId)?.versions.at(-1)
      for (const step of plan?.steps ?? []) {
        const s = state.steps.get(taskId)?.get(step.id)
        const status = s?.status ?? 'pending'
        const detail = s?.failure ? `  [${s.failure.class}] ${s.failure.message}` : (s?.output ? `  → ${s.output}` : '')
        console.log(`  ${step.id.padEnd(12)} ${status.padEnd(10)} attempt ${s?.attempt ?? 0}${detail}`)
      }
      const u = taskUsage(state, taskId)
      console.log(`  tokens in/out: ${u.inputTokens}/${u.outputTokens}  cost: ${u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`}`)
    })

  return program
}
