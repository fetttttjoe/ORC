<script lang="ts">
  import GateCard from '$lib/features/gates/GateCard.svelte'
  import LedgerRow from './LedgerRow.svelte'
  import RetryRow from './RetryRow.svelte'
  import WorkingLine from './WorkingLine.svelte'
  import PlanCard from './PlanCard.svelte'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { EVENT_KIND } from '$lib/event-kinds'

  let list = $state<HTMLElement | null>(null)
  let pinned = $state(true)

  const onscroll = (): void => {
    if (!list) return
    pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 60
  }

  // follow the tail only while the operator is at the tail
  $effect(() => {
    void ledger.rows
    if (pinned && list) list.scrollTop = list.scrollHeight
  })
</script>

<section aria-label="ledger" class="flex min-h-0 grow flex-col">
  <!-- gates stay pinned above the ledger, but BOUNDED: an unbounded block grew past the pane on
       a long question and painted over the copilot below it. Half the height at most, and its
       own scroll for the rest. -->
  <div id="open-gates" class="max-h-[50%] shrink-0 overflow-y-auto">
    {#each ledger.gates as gate (gate.taskId)}
      <GateCard {gate} />
    {/each}
  </div>
  <div bind:this={list} {onscroll} class="min-h-0 grow overflow-y-auto">
    {#if ledger.rows.length === 0}
      <p class="px-4 py-6 text-xs text-fog">the ledger fills as the project moves — every event lands here in log order</p>
    {/if}
    {#each ledger.rows as row, i (row.seq)}
      <LedgerRow {row} showTask={row.taskId !== ledger.rows[i - 1]?.taskId} />
      {#if row.kind === EVENT_KIND.step_failed && row.taskId !== null && ledger.retryable.includes(row.taskId)}
        <RetryRow taskId={row.taskId} />
      {/if}
      {#if row.kind === EVENT_KIND.plan_approved && row.taskId !== null}
        <PlanCard taskId={row.taskId} />
      {/if}
    {/each}
    {#if ledger.working !== null}
      <WorkingLine row={ledger.working} />
    {/if}
  </div>
</section>
