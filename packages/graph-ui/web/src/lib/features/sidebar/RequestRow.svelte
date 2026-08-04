<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar'
  import StatusPill from '$lib/components/StatusPill.svelte'
  import { cn } from '$lib/utils'
  import { statusTemperature, TEMP_DOT } from '$lib/temperature'
  import { session } from '$lib/stores/session.svelte'
  import type { GraphNode } from '$lib/api/types'

  let { task, waiting = false }: { task: GraphNode; waiting?: boolean } = $props()

  const temp = $derived(waiting ? 'human' : statusTemperature(task.detail))
</script>

<Sidebar.MenuItem>
  <Sidebar.MenuButton
    isActive={task.id === session.sel.node}
    class="h-auto py-1.5"
    onclick={() => session.navigate({ node: task.id, tab: 'request' })}
  >
    <span class={cn('size-1.5 shrink-0 rounded-[2px]', TEMP_DOT[temp])}></span>
    <span class="min-w-0 grow truncate text-xs" title={task.label}>{task.label}</span>
    <StatusPill status={task.detail} />
  </Sidebar.MenuButton>
</Sidebar.MenuItem>
