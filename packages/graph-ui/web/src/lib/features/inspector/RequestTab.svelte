<script lang="ts">
  // the task as a request: plan versions, the approved plan's waves, grounded plan notes,
  // and (when this server can act) the revise gate
  import { FAILURE_CLASS } from '@orc/contracts/execution'
  import { createQuery } from '@tanstack/svelte-query'
  import { SvelteSet } from 'svelte/reactivity'
  import InboxIcon from '@lucide/svelte/icons/inbox'
  import * as Empty from '$lib/components/ui/empty'
  import Chip from '$lib/components/Chip.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import FocusIcon from '@lucide/svelte/icons/scan-search'
  import { Textarea } from '$lib/components/ui/textarea'
  import StatusPill from '$lib/components/StatusPill.svelte'
  import LifecycleRail from './LifecycleRail.svelte'
  import StepRoad from './StepRoad.svelte'
  import PlanPanel from '$lib/features/plan/PlanPanel.svelte'
  import YourMoveCard from './YourMoveCard.svelte'
  import { yourMove } from './your-move'
  import { viewQuery } from '$lib/api/view-query'
  import { NODE_KIND, VIEW } from '@orc/ui-core/wire'
  import { api } from '$lib/api/client'
  import { actions } from '$lib/api/actions'
  import { notify } from '$lib/notify'
  import { operator } from '$lib/stores/operator.svelte'
  import { stepNodeId, taskIdOf } from '$lib/node-id'
  import { session } from '$lib/stores/session.svelte'
  import { fmtCost, fmtTokens, nodeHead } from './node-head'

  let { nodeId }: { nodeId: string } = $props()

  const taskId = $derived(taskIdOf(nodeId))

  const plans = createQuery(viewQuery(VIEW.plans, () => (taskId !== null ? { taskId } : null)))
  // an undecomposed task answers an empty note list, not a 404 — never a missing state to guard
  const notes = createQuery(viewQuery(VIEW.planNotes, () => (taskId !== null ? { taskId } : null)))
  const node = createQuery(viewQuery(VIEW.node, () => ({ id: nodeId })))

  const head = $derived(nodeHead(node.data))


  // chips pick a version; default follows approval (else the latest draft)
  let pickedVersion = $state<number | null>(null)
  const shownVersion = $derived(pickedVersion ?? plans.data?.approvedVersion ?? plans.data?.versions.at(-1)?.version ?? null)
  const shownPlan = $derived(plans.data?.versions.find(v => v.version === shownVersion))
  // waves are rendered server-side for ONE version only — other versions fall back to a flat list
  const waves = $derived(plans.data?.visual?.version === shownVersion ? (plans.data?.visual?.waves ?? null) : null)

  // the OLDEST open question on this task — a "your move" card shows one line; GateCard (in the
  // ledger and chat tab) is where every open question on the task renders, one card each
  const openQuestion = $derived(taskId === null ? null : (operator.questionsFor(taskId)[0]?.question ?? null))
  // read off the task detail's own artifacts, parsed once by the view client — a completion line
  // computed elsewhere claimed zero regardless
  const artifacts = $derived(node.data?.type === NODE_KIND.task ? node.data.artifacts : [])
  const failed = $derived(waves?.flatMap(w => w.steps).find(st => st.status === 'failed') ?? null)
  const failedStep = $derived(failed?.id ?? null)
  // a REJECTED step judged the work; retrying repeats it unchanged, so the pane offers revise
  const rejected = $derived(failed?.failureClass === FAILURE_CLASS.rejected)
  const move = $derived(
    taskId === null
      ? null
      : yourMove({
          taskId,
          status: head?.status ?? '',
          failedStepId: failedStep,
          rejected,
          openQuestion,
          artifactCount: artifacts.length,
        }),
  )

  const scope = new SvelteSet<string>()
  let reviseText = $state('')
  let revising = $state(false)

  async function submitRevise(): Promise<void> {
    const t = taskId
    if (t === null || revising) return
    revising = true
    try {
      await api.act('revise', { taskId: t, text: reviseText, scope: [...scope] })
      reviseText = ''
      scope.clear()
    } catch {
      // surfaced by the api error toast; the draft stays for retry
    } finally {
      revising = false
    }
  }
</script>

{#if taskId === null}
  <!-- the same Empty treatment the chat and detail tabs use — one vocabulary for "nothing here" -->
  <Empty.Root class="py-10">
    <Empty.Header>
      <Empty.Media variant="icon"><InboxIcon /></Empty.Media>
      <Empty.Title>no request</Empty.Title>
      <Empty.Description>this node belongs to no task, so there is no plan or lifecycle to show.</Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  {#if head?.status !== undefined}
    <LifecycleRail status={head.status} />
  {/if}
  {#if move !== null && move.kind !== 'none'}
    <YourMoveCard {move} taskId={taskId} plan={shownPlan} />
  {/if}

  <div class="flex items-center gap-2 border-b border-line px-3 pb-2">
    <Button
      variant={session.focus ? 'secondary' : 'ghost'}
      size="sm"
      class="h-6 text-row"
      title="dim everything in the graph outside this request's work"
      onclick={() => (session.focus = !session.focus)}
    >
      <FocusIcon data-icon="inline-start" />
      {session.focus ? 'focused' : 'focus graph'}
    </Button>
  </div>

  <div class="flex flex-col gap-4 p-3">
    {#if head !== null && (head.title !== undefined || head.status !== undefined)}
      <div>
        <div class="flex items-start gap-2">
          <h3 class="min-w-0 grow text-sm font-medium text-paper">{head.title ?? taskId}</h3>
          {#if head.status !== undefined}<StatusPill status={head.status} />{/if}
        </div>
        {#if head.costUSD !== null || head.tokens !== null}
          <p class="mt-1 font-mono text-row text-mist">
            {#if head.costUSD !== null}{fmtCost(head.costUSD)}{/if}
            {#if head.costUSD !== null && head.tokens !== null}&nbsp;·&nbsp;{/if}
            {#if head.tokens !== null}{fmtTokens(head.tokens)} tok{/if}
          </p>
        {/if}
      </div>
    {/if}

    <section>
      <p class="mb-1.5 font-mono text-label tracking-widest text-fog uppercase">plan</p>
      {#if plans.isPending}
        <Skeleton class="h-16 w-full" />
      {:else if !plans.data || plans.data.versions.length === 0}
        <p class="text-xs text-fog">no plan proposed yet</p>
      {:else}
        <div class="mb-2 flex flex-wrap gap-1.5">
          {#each plans.data.versions as v (v.version)}
            <button
              class={[
                'cursor-pointer rounded-(--radius-chip) border px-2 py-0.5 font-mono text-row',
                v.version === shownVersion ? 'border-machine/60 bg-desk text-paper' : 'border-line text-mist hover:text-paper',
              ]}
              title={v.version === plans.data.approvedVersion ? 'approved version' : v.strategyRef}
              onclick={() => (pickedVersion = v.version)}
            >
              v{v.version}{v.version === plans.data.approvedVersion ? ' ✓' : ''}
            </button>
          {/each}
        </div>

        {#if shownPlan}
          <div class="mb-3">
            <PlanPanel
              {taskId}
              steps={shownPlan.steps}
              {waves}
              onstepclick={id => session.navigate({ node: stepNodeId(taskId, id), tab: 'detail' })}
            />
          </div>
        {/if}
        {#if shownPlan}
          <StepRoad taskId={taskId} steps={shownPlan.steps} states={waves?.flatMap(w => w.steps) ?? []} />
        {/if}
      {/if}
    </section>

    <section>
      <p class="mb-1.5 font-mono text-label tracking-widest text-fog uppercase">plan notes</p>
      {#if notes.isPending}
        <Skeleton class="h-12 w-full" />
      {:else if !notes.data || notes.data.notes.length === 0}
        <p class="text-xs text-fog">no grounded decomposition yet</p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each notes.data.notes as n (n.id)}
            <article class="rounded-(--radius-card) border border-line bg-desk/40 p-3">
              <div class="flex items-start gap-2">
                {#if session.canAct()}
                  <input
                    type="checkbox"
                    class="mt-0.5 shrink-0 accent-(--color-human)"
                    title="include in revise scope"
                    checked={scope.has(n.id)}
                    onchange={() => (scope.has(n.id) ? scope.delete(n.id) : scope.add(n.id))}
                  />
                {/if}
                <div class="min-w-0 grow">
                  <p class="text-xs font-medium text-paper">{n.title}</p>
                  <p class="mt-1 text-xs text-mist">{n.summary}</p>
                  {#if n.modelRef !== undefined || n.zone.length > 0}
                    <div class="mt-2 flex flex-wrap gap-1">
                      {#if n.modelRef !== undefined}<Chip temp="machine" mono>{n.modelRef}</Chip>{/if}
                      {#each n.zone as zn (zn)}<Chip mono>{zn}</Chip>{/each}
                    </div>
                  {/if}
                  {#if n.uncertainty.length > 0}
                    <ul class="mt-2 list-disc pl-4 text-row text-human/90">
                      {#each n.uncertainty as u (u)}<li>{u}</li>{/each}
                    </ul>
                  {/if}
                </div>
              </div>
            </article>
          {/each}
        </div>

        {#if session.canAct()}
          <div class="mt-3 border-t border-line pt-3">
            <textarea
              bind:value={reviseText}
              rows="3"
              placeholder="what should change in these notes…"
              class="w-full resize-y rounded-(--radius-chip) border border-rule bg-ink px-2 py-1.5 text-xs text-paper placeholder:text-fog"
            ></textarea>
            <div class="mt-2 flex items-center justify-between gap-2">
              <span class="text-row text-fog">
                {scope.size === 0 ? 'tick the notes this revision targets' : `${scope.size} note${scope.size === 1 ? '' : 's'} in scope`}
              </span>
              <Button size="sm" disabled={reviseText.trim() === '' || scope.size === 0 || revising} onclick={submitRevise}>
                {revising ? 'revising…' : 'revise'}
              </Button>
            </div>
          </div>
        {/if}
      {/if}
    </section>
  </div>
{/if}
