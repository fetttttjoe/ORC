<script lang="ts">
  // failures expand with the error verbatim: an answer that does not take must say why
  import KindBadge from '$lib/components/KindBadge.svelte'
  import Payload from '$lib/components/Payload.svelte'
  import SeqTick from '$lib/components/SeqTick.svelte'
  import TimeTick from '$lib/components/TimeTick.svelte'
  import TaskChip from '$lib/components/TaskChip.svelte'
  import type { LogRow } from '$lib/api/types'
  import { session } from '$lib/stores/session.svelte'
  import { TEMP_BORDER } from '$lib/temperature'

  let { row, showTask = true }: { row: LogRow; showTask?: boolean } = $props()

  // the row's subject: the note it wrote, else the task that emitted it
  const target = $derived(row.noteRef ?? row.taskId)
  const temp = $derived(row.failure ? 'rust' : row.kind.startsWith('feedback') ? 'human' : 'neutral')
</script>

<svelte:element
  this={target ? 'button' : 'div'}
  role={target ? 'button' : undefined}
  tabindex={target ? 0 : undefined}
  title={target ? 'open in inspector' : undefined}
  onclick={target ? () => session.navigate({ node: target, tab: 'detail' }) : undefined}
  class={[
    'flex w-full items-baseline gap-2 border-b border-l-2 border-line/50 px-3 py-1.5 text-left transition-colors',
    TEMP_BORDER[temp],
    target && 'cursor-pointer hover:bg-desk/40',
    row.failure && 'border-b-rust/40 bg-rust/5',
  ]}
>
  <TimeTick ts={row.ts} />
  <SeqTick seq={row.seq} />
  <span class="shrink-0"><KindBadge kind={row.kind} /></span>
  {#if row.taskId && showTask}<span class="hidden shrink-0 sm:inline-flex"><TaskChip taskId={row.taskId} /></span>{/if}
  <span class="min-w-0 grow truncate text-xs text-mist" title={row.line}>{row.line}</span>
</svelte:element>
{#if row.failure}
  <div class="border-b border-rust/30 bg-rust/5 px-3 py-2 pl-33">
    <Payload label="{row.failure.toolName} refused" value={row.failure.error} temp="rust" />
  </div>
{/if}
