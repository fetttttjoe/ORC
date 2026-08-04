<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Temperature } from '$lib/temperature'
  import { TEMP_TEXT } from '$lib/temperature'

  /**
   * Fraction of a run that is finished. A ring rather than a bar because it reads at a glance
   * from across the room, and the middle is free for the number that matters.
   */
  let {
    done,
    total,
    temp = 'machine',
    label,
  }: {
    done: number
    total: number
    temp?: Temperature
    label?: string
  } = $props()

  const R = 15
  const CIRC = 2 * Math.PI * R
  const fraction = $derived(total > 0 ? Math.min(1, done / total) : 0)
</script>

<div class="relative size-11 shrink-0" title={label ?? `${done} of ${total} done`}>
  <svg viewBox="0 0 36 36" class="size-full -rotate-90">
    <circle cx="18" cy="18" r={R} fill="none" stroke="var(--color-line)" stroke-width="3" />
    <circle
      cx="18"
      cy="18"
      r={R}
      fill="none"
      stroke="currentColor"
      class={cn('transition-[stroke-dashoffset] duration-500', TEMP_TEXT[temp])}
      stroke-width="3"
      stroke-linecap="round"
      stroke-dasharray={CIRC}
      stroke-dashoffset={CIRC * (1 - fraction)}
    />
  </svg>
  <span class="absolute inset-0 flex items-center justify-center font-mono text-label tabular-nums text-paper">
    {done}/{total}
  </span>
</div>
