<script lang="ts">
  // the ledger interleaves every task; a row without its owner's name misleads
  import Chip from '$lib/components/Chip.svelte'
  import { graph } from '$lib/stores/graph.svelte'
  import { session } from '$lib/stores/session.svelte'

  let { taskId }: { taskId: string } = $props()
  const title = $derived(graph.taskTitle(taskId) ?? taskId.slice(0, 8))
</script>

<button class="min-w-0 max-w-40 shrink-0 cursor-pointer" title="open in inspector" onclick={() => session.navigate({ node: taskId, tab: 'request' })}>
  <Chip temp="neutral" title={graph.taskTitle(taskId) ?? taskId}>{title}</Chip>
</button>
