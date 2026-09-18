<script lang="ts">
  import ScrollIcon from '@lucide/svelte/icons/scroll-text'
  import * as Empty from '$lib/components/ui/empty'
  import { Skeleton } from '$lib/components/ui/skeleton'
  // the ledger filtered to this task — same rows, same renderer, one source of truth for shape
  import { createQuery } from '@tanstack/svelte-query'
  import LedgerRow from '$lib/features/ledger/LedgerRow.svelte'
  import { viewQuery } from '$lib/api/view-query'
  import { VIEW } from '@orc/ui-core/wire'
  import { taskIdOf } from '$lib/node-id'

  const LOG_LIMIT = 200

  let { nodeId }: { nodeId: string } = $props()

  const taskId = $derived(taskIdOf(nodeId))

  const log = createQuery(viewQuery(VIEW.timeline, () => (taskId !== null ? { taskId, limit: LOG_LIMIT } : null)))
</script>

{#if taskId === null}
  <!-- the same Empty treatment the chat and detail tabs use — one vocabulary for "nothing here" -->
  <Empty.Root class="py-10">
    <Empty.Header>
      <Empty.Media variant="icon"><ScrollIcon /></Empty.Media>
      <Empty.Title>no log slice</Empty.Title>
      <Empty.Description>this node belongs to no task, so there is no per-task log to filter.</Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else if log.isPending}
  <div class="flex flex-col gap-1.5 p-3">
    {#each [0, 1, 2, 3, 4, 5] as i (i)}<Skeleton class="h-4 w-full" />{/each}
  </div>
{:else if (log.data ?? []).length === 0}
  <p class="px-4 py-6 text-xs text-fog">no events for this task yet</p>
{:else}
  {#each log.data ?? [] as row (row.seq)}
    <!-- showTask=false: this slice is already ONE task, so the chip repeated the same id on
         every row and spent width the line needs in a narrow panel -->
    <LedgerRow {row} showTask={false} />
  {/each}
{/if}
