<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Temperature } from '$lib/temperature'
  import { TEMP_TEXT } from '$lib/temperature'

  let {
    label,
    value,
    temp = 'neutral',
    hint,
    onclick,
  }: {
    label: string
    value: number
    temp?: Temperature
    hint?: string | undefined
    onclick?: (() => void) | undefined
  } = $props()

  // a zero reads quiet whatever its temperature — only a live count earns color
  const tone = $derived(value > 0 ? TEMP_TEXT[temp] : 'text-fog')
</script>

<svelte:element
  this={onclick ? 'button' : 'div'}
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
  title={hint}
  {onclick}
  class={cn(
    'flex min-w-0 flex-1 items-baseline gap-1.5 rounded-(--radius-card) border border-line bg-bureau px-2.5 py-1.5 text-left transition-colors',
    onclick && 'cursor-pointer hover:border-rule hover:bg-desk',
  )}
>
  <span class={cn('shrink-0 font-mono text-sm leading-none font-medium tabular-nums', tone)}>{value}</span>
  <span class="truncate font-mono text-label tracking-widest text-fog uppercase" title={hint ?? label}>{label}</span>
</svelte:element>
