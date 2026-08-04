<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'

  // one label/value row. Values WRAP rather than overflow — a revision hash or a path is exactly
  // the kind of unbroken token that used to push a pane sideways.
  let { label, mono = false, children }: { label: string; mono?: boolean; children: Snippet } = $props()
</script>

<div class="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-2 py-0.5">
  <dt class="truncate font-mono text-label tracking-widest text-fog uppercase" title={label}>{label}</dt>
  <dd class={cn('min-w-0 text-xs break-words text-paper', mono && 'font-mono text-row')}>{@render children()}</dd>
</div>
