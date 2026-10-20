<script lang="ts">
  import { TASK_STATUS } from '@orc/contracts/task'
  import { cn } from '$lib/utils'

  // The path every task walks: past stages settled, the current one live, the rest quiet
  const STAGES = [
    { key: 'plan', label: 'plan' },
    { key: 'approve', label: 'approve' },
    { key: 'execute', label: 'execute' },
    { key: 'done', label: 'done' },
  ] as const

  const STAGE_OF: Record<string, number> = {
    [TASK_STATUS.draft]: 0,
    [TASK_STATUS.awaiting_approval]: 1,
    [TASK_STATUS.approved]: 2,
    [TASK_STATUS.running]: 2,
    [TASK_STATUS.blocked]: 2,
    [TASK_STATUS.failed]: 2,
    [TASK_STATUS.done]: 3,
    [TASK_STATUS.cancelled]: 3,
  }

  let { status }: { status: string } = $props()
  const at = $derived(STAGE_OF[status] ?? 0)
  const derailed = $derived(status === TASK_STATUS.blocked || status === TASK_STATUS.failed || status === TASK_STATUS.cancelled)
</script>

<ol class="flex items-center gap-1 px-3 py-2">
  {#each STAGES as stage, i (stage.key)}
    <li class="flex items-center gap-1">
      <span
        class={cn(
          'rounded-(--radius-chip) px-1.5 py-0.5 font-mono text-label tracking-widest uppercase transition-colors',
          i < at && 'text-moss',
          i === at && !derailed && 'bg-machine/12 text-machine',
          i === at && derailed && 'bg-rust/12 text-rust',
          i > at && 'text-fog',
        )}
      >
        {stage.label}
      </span>
      {#if i < STAGES.length - 1}<span class={cn('h-px w-3', i < at ? 'bg-moss/50' : 'bg-line')}></span>{/if}
    </li>
  {/each}
</ol>
