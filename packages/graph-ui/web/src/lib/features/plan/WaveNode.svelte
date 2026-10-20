<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte'
  import { statusTemperature, TEMP_BORDER, TEMP_TEXT } from '$lib/temperature'
  import { cn } from '$lib/utils'
  import type { WaveNodeData } from './plan-flow'

  // A wave drawn as the container its steps live in; pointer-events off so clicks reach the steps
  let { data }: NodeProps = $props()
  const wave = $derived(data as WaveNodeData)
  const temp = $derived(statusTemperature(wave.state))
</script>

<div
  class={cn(
    'pointer-events-none h-full w-full rounded-(--radius-card) border border-l-2 bg-desk/25 transition-colors',
    'border-line',
    TEMP_BORDER[temp],
  )}
>
  <div class="flex items-baseline gap-1.5 px-2 pt-1">
    <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[temp])}>wave {wave.rank + 1}</span>
    <span class="font-mono text-label text-fog">{wave.count === 1 ? 'alone' : `${wave.count} in parallel`}</span>
  </div>
</div>
