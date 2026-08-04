<script lang="ts">
  // wall-clock time for a log row. The seq is the ORDER; this is the when — an operator judging
  // "is it stuck?" or "how long did that step take?" cannot answer either from a sequence number.
  let { ts }: { ts: string } = $props()

  const at = $derived(new Date(ts))
  const clock = $derived(Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString(undefined, { hour12: false }))
</script>

{#if clock !== ''}
  <span class="w-14 shrink-0 font-mono text-label tabular-nums text-fog select-none" title={at.toLocaleString()}>{clock}</span>
{/if}
