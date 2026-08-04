<script lang="ts">
  import { cn } from '$lib/utils'

  /**
   * How far the run has got, as one bar. The number it renders comes from plan-status'
   * completedFraction — the same function the ring in the run monitor reads, so the two surfaces
   * cannot disagree about progress while both claim to show it.
   *
   * The fill animates on WIDTH rather than transform: a step completing should read as the bar
   * growing into the space, and a scaled bar blurs its own end cap.
   */
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
