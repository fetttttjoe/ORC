<script lang="ts">
  // Wall-clock time for a log row; the seq is the order, this is the when
  let { ts }: { ts: string } = $props()

  const at = $derived(new Date(ts))
  const clock = $derived(Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString(undefined, { hour12: false }))
</script>

{#if clock !== ''}
  <span class="w-14 shrink-0 font-mono text-label tabular-nums text-fog select-none" title={at.toLocaleString()}>{clock}</span>
{/if}
