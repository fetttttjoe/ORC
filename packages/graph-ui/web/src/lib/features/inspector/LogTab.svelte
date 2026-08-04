<script lang="ts">
  import { Skeleton } from '$lib/components/ui/skeleton'
  // the ledger filtered to this task — same rows, same renderer, one source of truth for shape
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query'
  import LedgerRow from '$lib/features/ledger/LedgerRow.svelte'
  import { api } from '$lib/api/client'
  import { taskIdOf } from '$lib/node-id'
  import { session } from '$lib/stores/session.svelte'

  const LOG_LIMIT = 200

  let { nodeId }: { nodeId: string } = $props()

  const project = $derived(session.sel.project)
  const taskId = $derived(taskIdOf(nodeId))

  const log = createQuery(() => ({
    queryKey: ['task', taskId ?? '', 'log'],
    queryFn: () => api.log(project, { ...(taskId !== null && { task: taskId }), limit: LOG_LIMIT }),
    enabled: taskId !== null && project !== '',
    // keep the last good answer on screen while a refetch runs
    placeholderData: keepPreviousData,
  }))
</script>

{#if taskId === null}
  <p class="px-4 py-6 text-xs text-fog">this node belongs to no task — no log slice</p>
{:else if log.isPending}
  <div class="flex flex-col gap-1.5 p-3">
    {#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton class="h-4 w-full" />{/each}
  </div>
{:else if (log.data ?? []).length === 0}
  <p class="px-4 py-6 text-xs text-fog">no events for this task yet</p>
{:else}
  {#each log.data ?? [] as row (row.seq)}
    <LedgerRow {row} />
  {/each}
{/if}
