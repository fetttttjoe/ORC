import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import { PlanDraft, STRATEGY, TASK_STATUS, formatModelRate } from '@orc/contracts'
import type { OrcConfig } from '@orc/kernel'
import { parsePlanFile, VAULT_TASKS_DIR } from '@orc/vault-projector'
import type { PlanSource } from '@orc/ui-core'
import { parseNonNegativeInteger } from './int-arg'
import { renderPlanHuman } from './plan-render'
import { DEFAULT_TEMPLATE_MODEL } from './plan-template'
import { CLI_ORIGIN, type ProgramDeps } from './program-deps'
import { watchSubtree } from './watch'

function parsePositiveNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new InvalidArgumentError(`must be a positive amount, got '${value}'`)
  return parsed
}

// an AUTHORED draft is the door's parsing job; the template arm lives in OrcActions.propose
function authoredDraft(opts: { file?: string; fromVault?: boolean }, taskId: string, config?: OrcConfig): PlanDraft {
  if (opts.fromVault && opts.file)
    throw new Error('--file and --from-vault name two different drafts — pass exactly one')
  if (opts.fromVault) {
    if (!config) throw new Error('--from-vault is unavailable in this context')
    const dir = path.join(config.vaultDir, VAULT_TASKS_DIR, taskId)
    const latest = readdirSync(dir)
      .filter(f => /^plan-v\d+\.md$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1)
    if (!latest) throw new Error(`no plan file in ${dir} — run 'orc vault render ${taskId}' first`)
    return parsePlanFile(readFileSync(path.join(dir, latest), 'utf8'))
  }
  if (!opts.file) throw new Error('no authored draft: pass --file or --from-vault')
  return PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8')))
}

export function taskCommands(deps: Pick<ProgramDeps, 'actions' | 'requireKernel' | 'plugin' | 'discovery' | 'rootOf' | 'watchFrom' | 'report'>): Command[] {
  const { actions, requireKernel, plugin, discovery, rootOf, watchFrom, report } = deps
  const group = new Command()
  group
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .option('--strategy <s>', `bootstrap strategy ('${STRATEGY.groundedPlan}' starts an analyze→plan conversation instead of a bare draft task)`)
    .option('--model <ref>', `model for the grounded-plan analyze/plan steps (required with --strategy ${STRATEGY.groundedPlan})`)
    .option('--analyzer <ref>', 'analyzer for the grounded-plan analyze step', 'agent-analyzer')
    // the kernel enforces TaskNode.budgetUSD; this is the only way to set one
    .option('--budget <usd>', 'cap total spend for this task and its subtree', parsePositiveNumber)
    .option('--workspace <id>', 'workspace for this task (default: the workspace this directory is)')
    .action(async (title: string, opts: { spec: string; parent?: string; strategy?: string; model?: string; analyzer: string; budget?: number; workspace?: string }) => {
      if (opts.strategy !== undefined && !Object.values(STRATEGY).some(v => v === opts.strategy))
        throw new Error(`unknown --strategy '${opts.strategy}' — valid strategies: ${Object.values(STRATEGY).join(', ')}`)
      // a root lands in the cwd's checkout, a child inherits its parent's; an explicit --workspace wins
      if (opts.strategy === STRATEGY.groundedPlan && !opts.model)
        throw new Error(`--model is required with --strategy ${STRATEGY.groundedPlan}`)
      const grounded = opts.strategy === STRATEGY.groundedPlan && opts.model
        // cwd null: the task's own workspace is the checkout it runs in, never this terminal's
        ? { grounded: { modelRef: opts.model, analyzerRef: opts.analyzer, cwd: null } }
        : {}
      const { taskId } = await actions().newTask({
        title, spec: opts.spec, parentId: opts.parent, budgetUSD: opts.budget ?? null,
        ...(opts.workspace !== undefined && { workspaceId: opts.workspace }), ...grounded,
      }, CLI_ORIGIN)
      console.log(taskId)
      // the action already requested the grounded run (policy-approved); this only watches it
      if (opts.strategy === STRATEGY.groundedPlan) await watchFrom(taskId, undefined)
    })
  const planSource = (taskId: string, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }): PlanSource =>
    opts.file || opts.fromVault
      ? { draft: authoredDraft(opts, taskId, plugin?.config) }
      : { template: { modelRef: opts.model, skillRefs: opts.skill ?? [] } }
  const planAction = <R extends { version: number }>(apply: (taskId: string, plan: PlanSource) => Promise<R>, describe: (result: R) => string) =>
    async (taskId: string, opts: { file?: string; model: string; skill?: string[]; fromVault?: boolean }) => {
      const result = await apply(taskId, planSource(taskId, opts))
      console.log(`plan v${result.version} ${describe(result)} — review with: orc plan ${taskId}`)
    }

  group
    .command('propose <taskId>')
    .description('stamp a plan for review (default: a single-step template of your spec — NO model call; --file supplies an authored multi-step draft)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', DEFAULT_TEMPLATE_MODEL)
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .action(planAction((id, plan) => actions().propose(id, plan, CLI_ORIGIN), r => `proposed (${r.steps} steps)`))

  group
    .command('edit <taskId>')
    .description('edit a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', DEFAULT_TEMPLATE_MODEL)
    .option('--skill <names...>', 'force-load skills for the template step (e.g. documentation)')
    .option('--from-vault', 'read the edited plan markdown from the vault')
    .action(planAction((id, plan) => actions().edit(id, plan, CLI_ORIGIN), () => 'edited'))

  // best-effort: no provider or discovery renders without a rate
  const rateFor = (ref: string): string | null => {
    if (!discovery) return null
    try {
      const { p, modelId } = discovery.providerFor(ref)
      return formatModelRate(p.costs[modelId] ?? p.costs['*'])
    } catch { return null }
  }

  group
    .command('plan <taskId>')
    .description('show a plan for review (latest by default; --json for the raw draft)')
    .option('--version <n>', 'plan version', parseNonNegativeInteger)
    .option('--json', 'raw plan JSON (scripts; the full field set)')
    .action(async (taskId: string, opts: { version?: number; json?: boolean }) => {
      const plan = await requireKernel().getPlan(taskId, opts.version)
      if (!plan) throw new Error(`no plan for task '${taskId}'`)
      if (opts.json) { console.log(JSON.stringify(plan, null, 2)); return }
      console.log(renderPlanHuman(plan, rateFor))
      console.log(`approve: orc approve ${taskId} · raw: orc plan ${taskId} --json`)
    })

  group
    .command('approve <taskId>')
    .description('approve the latest plan (the human gate)')
    .option('--version <n>', 'expected version (fails if stale)', parseNonNegativeInteger)
    .action(async (taskId: string, opts: { version?: number }) => {
      const root = await rootOf(taskId)
      const { version } = await actions().approve(taskId, { ...(opts.version !== undefined && { version: opts.version }) }, CLI_ORIGIN)
      console.log(`plan v${version} approved`)
      if (root === taskId) return
      // watch the ROOT, whose join is waiting, and only while it runs: approving never starts a run
      if ((await requireKernel().getTask(root))?.status !== TASK_STATUS.running) return
      console.log(`watching the run at ${root}`)
      await report(await watchSubtree(requireKernel(), root), root)
    })

  group
    .command('plan-note <taskId> <noteId> <text>')
    .description('annotate a plan-note (grounded-plan) — the plan-authoring agent reads it on its next revise')
    .option('--ref <ids...>', 'related plan-note ids')
    .action(async (taskId: string, noteId: string, text: string, opts: { ref?: string[] }) => {
      await actions().annotate(taskId, noteId, text, opts.ref ?? [], CLI_ORIGIN)
      console.log(`noted on '${noteId}'`)
    })

  group
    .command('reply <taskId> <text>')
    .description("answer a task's open feedback question (e.g. 'orc reply <taskId> approve'), then drive the resumed run")
    .action(async (taskId: string, text: string) => {
      // answering only unblocks the step: the action ensures a supervisor first, no run is requested
      const topic = (await requireKernel().openFeedback(taskId))?.topic
      const { answered } = await actions().reply(taskId, text, undefined, CLI_ORIGIN)
      if (!answered) {
        console.log(`no open feedback question for task '${taskId}'`)
        return
      }
      console.log(`answered feedback:${topic}`)
      // the answered task may be a split child: the cost line sums from the ROOT of the tree
      await report(await watchSubtree(requireKernel(), taskId), await rootOf(taskId))
    })

  group
    .command('plan-revise <taskId> <text>')
    .description('targeted re-plan (grounded-plan): annotate each --scope note with <text>, then resume the plan agent to revise just those notes')
    .requiredOption('--scope <ids...>', 'plan-note ids to revise (only they and the subplans they list change; every other note stays byte-stable)')
    .action(async (taskId: string, text: string, opts: { scope: string[] }) => {
      // annotate-and-resume: queue the change onto each scoped plan note, then wake the plan step
      const { topic } = await actions().revise(taskId, text, opts.scope, CLI_ORIGIN)
      console.log(topic
        ? `revised ${opts.scope.join(', ')} — answered feedback:${topic}`
        : `annotated ${opts.scope.join(', ')} — no open feedback to resume (the agent reads them on its next revise)`)
    })
  return [...group.commands]
}
