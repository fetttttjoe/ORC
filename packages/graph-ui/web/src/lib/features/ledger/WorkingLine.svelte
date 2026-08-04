<script lang="ts">
  import SeqTick from '$lib/components/SeqTick.svelte'
  import TimeTick from '$lib/components/TimeTick.svelte'
  import TaskChip from '$lib/components/TaskChip.svelte'
  import type { LogRow } from '$lib/api/types'

  // one live line for the agent loop: what it is doing right now, replaced in place
  let { row }: { row: LogRow } = $props()
  const what = $derived(`${row.kind.replace(/_/g, ' ')}  ${row.line}`.trim())
</script>

<div class="flex items-baseline gap-2 border-b border-line/40 bg-machine/4 px-3 py-1.5">
  <TimeTick ts={row.ts} />
  <SeqTick seq={row.seq} />
  <span class="breathe size-1.5 shrink-0 rounded-full bg-machine"></span>
  {#if row.taskId}<TaskChip taskId={row.taskId} />{/if}
  <span class="min-w-0 grow truncate font-mono text-row text-mist" title={what}>{what}</span>
</div>
