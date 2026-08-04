<script lang="ts">
  import ChevronIcon from '@lucide/svelte/icons/chevron-right'
  import NetworkIcon from '@lucide/svelte/icons/git-fork'
  import ExpandIcon from '@lucide/svelte/icons/maximize-2'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { slide } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import PlanBoard from './PlanBoard.svelte'
  import PlanGraph from './PlanGraph.svelte'
  import PlanProgress from './PlanProgress.svelte'
  import { completedFraction } from './plan-status'
  import { cn } from '$lib/utils'
  import type { FlowStep } from './plan-flow'
  import type { EditableStep } from './plan-edit'
  import type { WaveStep } from '$lib/api/types'

  /**
   * The plan, at three depths the operator chooses between: a progress bar always, the wave rail
   * under it, and the dependency graph dropped out below that.
   *
   * The bar is the summary that is ALWAYS true — it needs no plan version and no visual, so it
   * renders even while the rest is loading. Everything heavier is behind a disclosure, because the
   * inspector is a column and a graph opened by default pushes the plan notes off the pane.
   *
   * Owning the disclosure here (rather than in RequestTab) is what keeps the ledger card and the
   * inspector from growing two different answers to "is the graph open?".
   */
  interface Props {
    steps: readonly (FlowStep & EditableStep)[]
    /** the projected wave layering; null when the shown version has no visual yet */
    waves: readonly { wave: number; parallel: boolean; steps: readonly WaveStep[] }[] | null
    taskId: string
    onstepclick?: ((stepId: string) => void) | undefined
    onlink?: ((next: (FlowStep & EditableStep)[]) => void) | undefined
    onrefused?: ((reason: string) => void) | undefined
  }

  let { steps, waves, taskId, onstepclick, onlink, onrefused }: Props = $props()

  // Open by default. It started collapsed to keep the plan notes above the fold, but the graph is
  // the thing an operator opens this tab FOR, and a dim text link below the rail was hunted for
  // twice before being found. A control you have to search for is a control that does not exist.
  let open = $state(true)
  // The big canvas. Separate state from `open` on purpose: closing the dialog must return you to
  // whatever the inline panel was doing, not collapse it. Editing a plan needs room the inspector
  // column does not have, so this is where the pre-approval editor will live.
  let big = $state(false)

  const statuses = $derived(waves?.flatMap(w => w.steps.map(s => s.status)) ?? [])
  const statusOf = $derived.by(() => {
    const map = new Map((waves ?? []).flatMap(w => w.steps.map(s => [s.id, s.status] as const)))
    return (id: string): string | undefined => map.get(id)
  })
</script>

<PlanProgress fraction={completedFraction(statuses)} total={statuses.length} done={statuses.filter(s => s === 'completed' || s === 'done').length} />

{#if waves !== null}
  <div class="mt-2"><PlanBoard {taskId} {waves} /></div>
{/if}

<Button
  variant={open ? 'secondary' : 'outline'}
  size="sm"
  class="mt-2 h-6 w-full justify-start text-row"
  aria-expanded={open}
  title="the dependency graph — which step gates which"
  onclick={() => (open = !open)}
>
  <ChevronIcon class={cn('size-3 transition-transform duration-200', open && 'rotate-90')} />
  <NetworkIcon class="size-3" />
  {open ? 'hide' : 'show'} dependency graph
</Button>

{#if open}
  <div class="relative mt-1.5" transition:slide={{ duration: 220, easing: cubicOut }}>
    <PlanGraph {steps} {statusOf} {onstepclick} {onlink} {onrefused} />
    <Button
      variant="outline"
      size="icon"
      class="absolute top-2 right-2 z-10 size-6 bg-desk/90"
      title="open the graph full size"
      aria-label="expand plan graph"
      onclick={() => (big = true)}
    >
      <ExpandIcon class="size-3" />
    </Button>
  </div>
{/if}

<!-- The same PlanGraph, the same adapter, the same edit seam — only the box is bigger. Nothing
     about the graph is duplicated here, which is what makes the editor land in one place later. -->
<Dialog.Root bind:open={big}>
  <Dialog.Content class="flex h-[88vh] max-w-[min(1400px,94vw)] flex-col gap-2 sm:max-w-[min(1400px,94vw)]">
    <Dialog.Header class="shrink-0">
      <Dialog.Title>plan dependencies</Dialog.Title>
      <Dialog.Description>which step gates which. Drag to pan, scroll to zoom; click a step to open it.</Dialog.Description>
    </Dialog.Header>
    <div class="min-h-0 grow">
      <PlanGraph {steps} {statusOf} {onstepclick} {onlink} {onrefused} expanded />
    </div>
  </Dialog.Content>
</Dialog.Root>
