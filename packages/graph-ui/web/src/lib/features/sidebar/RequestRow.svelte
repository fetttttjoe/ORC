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

  // Active when the selection BELONGS to this request, not only when it IS this request. Clicking
  // a step or an artifact inside an open request selects `step:<task>:<id>`, which never equalled
  // the task id — so the row you were reading silently lost its highlight the moment you drilled
  // into it, and the rail stopped saying where you were.
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
