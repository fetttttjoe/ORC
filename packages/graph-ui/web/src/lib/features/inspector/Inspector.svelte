<script lang="ts">
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import XIcon from '@lucide/svelte/icons/x'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Button } from '$lib/components/ui/button'
  import { ScrollArea } from '$lib/components/ui/scroll-area'
  import { graph } from '$lib/stores/graph.svelte'
  import { session, type Tab } from '$lib/stores/session.svelte'
  import ChatTab from './ChatTab.svelte'
  import DetailTab from './DetailTab.svelte'
  import LogTab from './LogTab.svelte'
  import RequestTab from './RequestTab.svelte'

  // right dock: whatever node the operator selected, inspected without leaving the ledger
  const TABS: readonly Tab[] = ['request', 'detail', 'chat', 'log']

  const nodeId = $derived(session.sel.node)
  // every selection is a hash write, so history.back() is the node history; no bespoke stack
  const canGoBack = $derived(session.visited > 1)
  const label = $derived(nodeId === null ? '' : (graph.nodes.get(nodeId)?.label ?? nodeId))
</script>

{#if nodeId !== null}
  <aside aria-label="inspector" class="flex h-full w-[26rem] max-w-full shrink-0 flex-col overflow-hidden border-l border-line bg-bureau">
    <header class="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-1 pl-1.5">
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        disabled={!canGoBack}
        title="back to where you came from"
        onclick={() => history.back()}
      >
        <ArrowLeftIcon />
      </Button>
      <h2 class="min-w-0 grow truncate text-[13px] font-medium text-paper" title={label}>{label}</h2>
      <Button variant="ghost" size="icon" class="size-7 shrink-0" title="close inspector" onclick={() => session.navigate({ node: null })}>
        <XIcon />
      </Button>
    </header>

    <Tabs.Root
      bind:value={() => session.sel.tab, (v: string) => session.navigate({ tab: v as Tab })}
      class="flex min-h-0 grow flex-col gap-0"
    >
      <Tabs.List class="h-8 w-full shrink-0 justify-start rounded-none border-b border-line bg-transparent p-0">
        {#each TABS as t (t)}
          <Tabs.Trigger value={t} class="h-8 rounded-none border-b-2 border-transparent px-3 font-mono text-row data-[state=active]:border-machine data-[state=active]:bg-transparent data-[state=active]:text-paper">
            {t}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>

      <ScrollArea class="min-h-0 grow">
        <!-- keyed: per-node ephemera (revise scope, picked plan version) must not leak across nodes -->
        {#key nodeId}
          <Tabs.Content value="request" class="mt-0"><RequestTab {nodeId} /></Tabs.Content>
          <Tabs.Content value="detail" class="mt-0"><DetailTab {nodeId} /></Tabs.Content>
          <Tabs.Content value="chat" class="mt-0"><ChatTab {nodeId} /></Tabs.Content>
          <Tabs.Content value="log" class="mt-0"><LogTab {nodeId} /></Tabs.Content>
        {/key}
      </ScrollArea>
    </Tabs.Root>
  </aside>
{/if}
