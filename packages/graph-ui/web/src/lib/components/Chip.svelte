<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'
  import type { Temperature } from '$lib/temperature'

  /**
   * The one labelled chip. Built on the registry Badge so overflow, focus and shape come from the
   * design system; `temp` paints it with the two-temperature vocabulary, and the label truncates
   * inside its own box — an unclipped chip used to spill across the row it belongs to.
   */
  let {
    temp = 'neutral',
    mono = false,
    title,
    class: klass = '',
    children,
  }: {
    temp?: Temperature
    mono?: boolean
    title?: string
    class?: string
    children: Snippet
  } = $props()

  const TONES: Record<Temperature, string> = {
    human: 'border-human/45 bg-human/10 text-human',
    machine: 'border-machine/40 bg-machine/10 text-machine',
    moss: 'border-moss/40 bg-moss/10 text-moss',
    rust: 'border-rust/45 bg-rust/10 text-rust',
    neutral: 'border-line bg-transparent text-mist',
  }
</script>

<Badge variant="outline" {title} class={cn('h-4.5 max-w-40 rounded-(--radius-chip) px-1.5 text-row font-normal', mono && 'font-mono', TONES[temp], klass)}>
  <span class="truncate">{@render children()}</span>
</Badge>
