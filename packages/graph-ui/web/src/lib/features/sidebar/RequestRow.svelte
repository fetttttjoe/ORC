<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar'
  import StatusPill from '$lib/components/StatusPill.svelte'
  import { cn } from '$lib/utils'
  import { statusTemperature, TEMP_DOT } from '$lib/temperature'
  import { session } from '$lib/stores/session.svelte'
  import { taskIdOf } from '$lib/node-id'
  import type { GraphNode } from '$lib/api/types'

  let { task, waiting = false }: { task: GraphNode; waiting?: boolean } = $props()

  const temp = $derived(waiting ? 'human' : statusTemperature(task.detail))

  // Active when the selection BELONGS to this request: a step selection never equals the task id
  const active = $derived(session.sel.node !== null && taskIdOf(session.sel.node) === task.id)
</script>

<Sidebar.MenuItem>
  <Sidebar.MenuButton
    isActive={active}
    class="h-auto border-l-2 border-l-transparent py-1.5 data-active:border-l-machine"
    onclick={() => session.navigate({ node: task.id, tab: 'request' })}
  >
    <span class={cn('size-1.5 shrink-0 rounded-[2px]', TEMP_DOT[temp])}></span>
    <span class="min-w-0 grow truncate text-xs" title={task.label}>{task.label}</span>
    <StatusPill status={task.detail} />
  </Sidebar.MenuButton>
</Sidebar.MenuItem>
