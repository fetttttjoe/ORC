<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Temperature } from '$lib/temperature'
  import { TEMP_BORDER, TEMP_TEXT } from '$lib/temperature'

  // Tool JSON sunken, with a temperature rail so the result reads as the answer
  let {
    label,
    value,
    temp = 'neutral',
    empty = '',
  }: {
    label: string
    value: unknown
    temp?: Temperature
    /** shown when the payload is absent — silence and "nothing came back" are different facts */
    empty?: string
  } = $props()

  const text = $derived(value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  const lines = $derived(text === '' ? 0 : text.split('\n').length)
</script>

<figure class={cn('overflow-hidden rounded-(--radius-chip) border border-l-2 border-line bg-ink', TEMP_BORDER[temp])}>
  <figcaption class="flex items-baseline gap-2 border-b border-line/60 px-2 py-1">
    <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[temp])}>{label}</span>
    {#if lines > 1}<span class="font-mono text-label text-fog">{lines} lines</span>{/if}
  </figcaption>
  {#if text === ''}
    <p class="px-2 py-1.5 font-mono text-row text-fog italic">{empty || 'empty'}</p>
  {:else}
    <pre class="max-h-56 overflow-auto px-2 py-1.5 font-mono text-row leading-relaxed whitespace-pre-wrap text-paper/85">{text}</pre>
  {/if}
</figure>
