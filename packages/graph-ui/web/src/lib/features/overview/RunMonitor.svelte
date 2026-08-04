<script lang="ts">
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query'
  import { STEP_RUN_STATUS } from '@orc/contracts/execution'
  import ProgressRing from './ProgressRing.svelte'
  import Chip from '$lib/components/Chip.svelte'
  import NodeLink from '$lib/components/NodeLink.svelte'
  import { api } from '$lib/api/client'
  import { qk } from '$lib/query-keys'
  import { parseOrReport } from '$lib/api/parse'
  import { stepNodeId } from '$lib/node-id'
  import { graph } from '$lib/stores/graph.svelte'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { session } from '$lib/stores/session.svelte'
  import { cn } from '$lib/utils'
  import { TaskDetail } from '$lib/features/inspector/detail-view'
  import { fmtCost, fmtTokens } from '$lib/features/inspector/node-head'

  /**
   * What is happening RIGHT NOW, for the task that is happening.
   *
   * The tiles above count states; the ledger narrates the past. Neither answers the question an
   * operator actually asks while a run is live — how far along is it, what is each agent doing,
   * how close is it to its iteration ceiling, and what has it cost so far. All of that is on the
   * wire already; nothing here polls anything the stream does not already invalidate.
   */
  let { taskId }: { taskId: string } = $props()

  const project = $derived(session.sel.project)

  const node = createQuery(() => ({
    queryKey: qk.node(taskId),
    queryFn: () => api.node(project, taskId),
    enabled: project !== '',
    placeholderData: keepPreviousData,
  }))
  const plans = createQuery(() => ({
    queryKey: qk.taskPlans(taskId),
    queryFn: () => api.plans(project, taskId),
    enabled: project !== '',
    placeholderData: keepPreviousData,
  }))

  const detail = $derived(node.data ? parseOrReport(TaskDetail, node.data, 'run monitor (task)') : null)
  const steps = $derived(detail?.steps ?? [])
  const done = $derived(steps.filter(s => s.status === STEP_RUN_STATUS.completed).length)
  const running = $derived(steps.filter(s => s.status === STEP_RUN_STATUS.running))
  const failed = $derived(steps.filter(s => s.status === STEP_RUN_STATUS.failed).length)

  /** the iteration ceiling each step was frozen with — the number a stuck agent runs into */
  const ceilings = $derived(new Map((plans.data?.versions.at(-1)?.steps ?? []).map(s => [s.id, s.maxIterations])))
  const modelOf = $derived(new Map((plans.data?.versions.at(-1)?.steps ?? []).map(s => [s.id, s.modelRef])))

  const title = $derived(graph.taskTitle(taskId) ?? taskId.slice(0, 8))
  const spend = $derived(detail?.usage?.costUSD ?? null)
  const tokens = $derived(detail?.usage ? detail.usage.inputTokens + detail.usage.outputTokens : null)
  const budget = $derived(detail?.task.budgetUSD ?? null)
  // the newest agent-loop line names the tool in flight; the ledger already tracks it
  const nowDoing = $derived(ledger.working?.taskId === taskId ? ledger.working.line : null)
</script>

<article class="flex flex-col gap-2 rounded-(--radius-card) border border-line bg-bureau p-2.5" aria-label="run monitor">
  <header class="flex items-center gap-2.5">
    <ProgressRing done={done + failed} total={steps.length} temp={failed > 0 ? 'rust' : 'machine'} label="steps finished" />
    <div class="min-w-0 grow">
      <NodeLink node={taskId} label={title} tab="request" />
      <p class="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-label text-fog">
        <span>{running.length} running</span>
        {#if failed > 0}<span class="text-rust">{failed} failed</span>{/if}
        {#if spend !== null}<span class="text-mist">{fmtCost(spend)}{budget !== null ? ` of ${fmtCost(budget)}` : ''}</span>{/if}
        {#if tokens !== null}<span>{fmtTokens(tokens)} tok</span>{/if}
      </p>
    </div>
  </header>

  {#each running as step (step.stepId)}
    {@const ceiling = ceilings.get(step.stepId)}
    {@const used = step.iterations ?? 0}
    {@const near = ceiling !== undefined && ceiling > 0 && used / ceiling >= 0.8}
    <div class="flex flex-col gap-1 border-l-2 border-machine/50 pl-2">
      <div class="flex min-w-0 items-baseline gap-2">
        <span class="breathe size-1.5 shrink-0 rounded-full bg-machine"></span>
        <span class="min-w-0 grow truncate text-row text-paper">
          <NodeLink node={stepNodeId(taskId, step.stepId)} label={step.stepId} />
        </span>
        {#if modelOf.get(step.stepId)}<Chip mono>{modelOf.get(step.stepId)}</Chip>{/if}
        {#if ceiling !== undefined}
          <span class={cn('shrink-0 font-mono text-label tabular-nums', near ? 'text-human' : 'text-fog')} title="agent turns used of the ceiling this step was frozen with">
            {used}/{ceiling}
          </span>
        {/if}
      </div>
      {#if ceiling !== undefined && ceiling > 0}
        <!-- the iteration ceiling is the thing a looping agent actually hits, so show the room left -->
        <div class="h-0.5 w-full overflow-hidden rounded-full bg-line">
          <div class={cn('h-full transition-[width] duration-500', near ? 'bg-human' : 'bg-machine')} style:width="{Math.min(100, (used / ceiling) * 100)}%"></div>
        </div>
      {/if}
    </div>
  {/each}

  {#if nowDoing}
    <p class="truncate font-mono text-label text-fog" title={nowDoing}>{nowDoing}</p>
  {/if}
</article>
