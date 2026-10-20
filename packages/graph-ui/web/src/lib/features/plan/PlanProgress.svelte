<script lang="ts">
  import { cn } from '$lib/utils'

  // One bar fed by plan-status' completedFraction, as the ring is; the fill animates on width
  let { fraction, done, total }: { fraction: number; done: number; total: number } = $props()

  const pct = $derived(Math.round(Math.min(1, Math.max(0, fraction)) * 100))
  const complete = $derived(total > 0 && done === total)
</script>

<div class="flex items-center gap-2">
  <div class="h-1 grow overflow-hidden rounded-full bg-desk">
    <div
      class={cn('h-full rounded-full transition-[width] duration-500 ease-out', complete ? 'bg-moss' : 'bg-machine')}
      style:width={`${pct}%`}
    ></div>
  </div>
  <span class="shrink-0 font-mono text-label text-fog tabular-nums">
    {#if total === 0}no steps{:else}{done}/{total}{/if}
  </span>
</div>
