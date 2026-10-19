<script lang="ts">
  import { TASK_STATUS } from '@orc/contracts/task'
  import MessageIcon from '@lucide/svelte/icons/message-square'
  import * as Sidebar from '$lib/components/ui/sidebar'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import RequestRow from './RequestRow.svelte'
  import ProjectMenu from '$lib/features/chrome/ProjectMenu.svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import ChevronIcon from '@lucide/svelte/icons/chevron-down'
  import PlusIcon from '@lucide/svelte/icons/plus'

  // finished work collapses by default: 20+ settled requests otherwise bury what needs attention
  const GROUPS = [
    { key: 'needsYou', label: 'needs you' },
    { key: 'running', label: 'running' },
    { key: 'open', label: 'not planned yet' },
    { key: 'settled', label: 'settled' },
  ] as const
  import { graph } from '$lib/stores/graph.svelte'
  import { operator } from '$lib/stores/operator.svelte'
  import { session } from '$lib/stores/session.svelte'
  import type { GraphNode } from '$lib/api/types'

  let { children }: { children?: import('svelte').Snippet<[{ close: () => void }]> } = $props()

  let composerOpen = $state(false)

  const gated = $derived(new Set(operator.state.openQuestions.map(g => g.taskId)))

  // Requests grouped by what they need from the operator. Split children stay out of the top
  // level — they render inside their parent's request view.
  /**
   * Grouped by what the request wants from the operator, not by raw status. Anything that CANNOT
   * move without a human — an open question, a plan awaiting approval, a blocked or failed run —
   * sits at the top; a fresh draft is open work, not settled history (it landed in the collapsed
   * settled pile once, which is how a just-created request went missing).
   */
  const groups = $derived.by(() => {
    const needsYou: GraphNode[] = []
    const running: GraphNode[] = []
    const open: GraphNode[] = []
    const settled: GraphNode[] = []
    for (const t of graph.tasks()) {
      if (graph.parentOf(t.id)) continue
      if (gated.has(t.id) || t.detail === TASK_STATUS.awaiting_approval || t.detail === TASK_STATUS.blocked || t.detail === TASK_STATUS.failed) needsYou.push(t)
      else if (t.detail === TASK_STATUS.running || t.detail === TASK_STATUS.approved) running.push(t)
      else if (t.detail === TASK_STATUS.draft) open.push(t)
      else settled.push(t)
    }
    return { needsYou, running, open, settled }
  })

  const loading = $derived(graph.nodes.size === 0)
</script>

<Sidebar.Root collapsible="none" role="navigation" aria-label="requests" class="w-72 shrink-0 overflow-hidden border-r border-line bg-bureau">
  {#if children}
    <Sidebar.Header class="p-2">
      <Dialog.Root bind:open={composerOpen}>
        <Dialog.Trigger class="min-w-0">
          {#snippet child({ props })}
            <Button {...props} size="sm" class="w-full min-w-0 justify-start">
              <PlusIcon data-icon="inline-start" />
              new request
            </Button>
          {/snippet}
        </Dialog.Trigger>
        <Dialog.Content class="sm:max-w-lg">
          <Dialog.Header>
            <Dialog.Title>new request</Dialog.Title>
            <Dialog.Description>describe the outcome — a grounded request analyses the repo and decomposes it before asking you to approve.</Dialog.Description>
          </Dialog.Header>
          {@render children({ close: () => (composerOpen = false) })}
        </Dialog.Content>
      </Dialog.Root>
    </Sidebar.Header>
  {/if}

  <Sidebar.Content class="gap-0">
    <Sidebar.Group>
      <Sidebar.GroupLabel class="flex items-center justify-between pr-1 font-mono text-label tracking-widest text-fog uppercase">
        chats
        <ProjectMenu />
      </Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each session.projects as p (p.id)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton isActive={p.id === session.sel.project} onclick={() => session.navigate({ project: p.id, node: null })}>
                <MessageIcon />
                <span class="truncate">{p.name ?? p.id.slice(0, 8)}</span>
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>

    {#if loading}
      <Sidebar.Group>
        <Sidebar.GroupContent class="flex flex-col gap-2 px-2">
          {#each [0, 1, 2, 3] as i (i)}
            <Skeleton class="h-6 w-full" />
          {/each}
        </Sidebar.GroupContent>
      </Sidebar.Group>
    {:else}
      {#each GROUPS as group (group.key)}
        {@const items = groups[group.key]}
        {#if items.length > 0}
          <Collapsible.Root open={group.key !== 'settled'}>
            <Sidebar.Group class="py-1">
              <Collapsible.Trigger class="w-full">
                <Sidebar.GroupLabel class="flex w-full cursor-pointer items-center gap-1 font-mono text-label tracking-widest text-fog uppercase hover:text-mist">
                  <ChevronIcon class="size-3 transition-transform in-data-[state=closed]:-rotate-90" />
                  {group.label}
                  <span class="text-fog/70">{items.length}</span>
                </Sidebar.GroupLabel>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Sidebar.GroupContent>
                  <Sidebar.Menu>
                    {#each items as task (task.id)}
                      <RequestRow {task} waiting={group.key === 'needsYou'} />
                    {/each}
                  </Sidebar.Menu>
                </Sidebar.GroupContent>
              </Collapsible.Content>
            </Sidebar.Group>
          </Collapsible.Root>
        {/if}
      {/each}
    {/if}
  </Sidebar.Content>
</Sidebar.Root>
