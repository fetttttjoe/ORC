<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { session } from '$lib/stores/session.svelte'
  import type { Tab } from '$lib/stores/session.svelte'

  let { node, label, tab = 'detail' }: { node: string; label?: string; tab?: Tab } = $props()
</script>

<Button variant="link" class="h-auto min-w-0 max-w-full justify-start p-0 text-left text-xs" onclick={() => session.navigate({ node, tab })}>
  <span class="min-w-0 truncate" title={label ?? node}>{label ?? node}</span>
</Button>
