<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import StatusPill from '$lib/components/StatusPill.svelte'
  import PlanBoard from '$lib/features/plan/PlanBoard.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { viewQuery } from '$lib/api/view-query'
  import { VIEW } from '@orc/ui-core/wire'
  import { stepNodeId } from '$lib/node-id'
  import { graph } from '$lib/stores/graph.svelte'
  import { cn } from '$lib/utils'
  import { statusTemperature, TEMP_DOT } from '$lib/temperature'

  // The task's live shape, in the feed where the operator is already looking: waves as rows,
  // steps as chips that carry their own status and open in the inspector.
  let { taskId }: { taskId: string } = $props()

  const plans = createQuery(viewQuery(VIEW.plans, () => ({ taskId })))

  const waves = $derived(plans.data?.visual?.waves ?? [])
  const title = $derived(graph.taskTitle(taskId) ?? taskId)
  const status = $derived(graph.taskStatus(taskId) ?? '')
</script>

{#if waves.length > 0}
  <article class="mx-3 my-2 rounded-(--radius-card) border border-line bg-bureau">
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <span class={cn('size-1.5 shrink-0 rounded-[2px]', TEMP_DOT[statusTemperature(status)])}></span>
      <h4 class="min-w-0 grow truncate text-xs font-medium text-paper" title={title}>{title}</h4>
      {#if status !== ''}<StatusPill {status} />{/if}
      <Badge variant="outline" class="font-mono">{waves.length} wave{waves.length === 1 ? '' : 's'}</Badge>
    </header>
    <div class="px-3 py-2">
      <PlanBoard {taskId} {waves} compact />
    </div>
  </article>
{/if}
