<script lang="ts">
  import { tick } from 'svelte'
  import GateCard from '$lib/features/gates/GateCard.svelte'
  import LedgerRow from './LedgerRow.svelte'
  import RetryRow from './RetryRow.svelte'
  import WorkingLine from './WorkingLine.svelte'
  import PlanCard from './PlanCard.svelte'
  import { feedbackKey } from '@orc/contracts/feedback-key'
  import { fetchView } from '$lib/api/view-client'
  import { VIEW } from '@orc/ui-core/wire'
  import { ScopeType } from '@orc/contracts/scope'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { operator } from '$lib/stores/operator.svelte'
  import { session } from '$lib/stores/session.svelte'
  import { dropTicker } from '$lib/stores/ledger-merge'
  import { EVENT_KIND, WORKING } from '$lib/event-kinds'

  // one backward page — the same window the boot load uses, so paging feels like more of the same
  const OLDER_PAGE = 150
  // ticker-only pages auto-chain up to this many fetches per click, so one click is never a no-op
  const NOISE_CHAIN = 5

  let list = $state<HTMLElement | null>(null)
  let pinned = $state(true)
  let loadingOlder = $state(false)
  // flips when a page comes back empty — the log has no rows before the pane's first
  let exhausted = $state(false)
  // Where paging reached: an all-noise page prepends nothing, so rows[0] would refetch it forever
  let oldestFetched = $state<number | null>(null)

  // Keyed on ledger.generation, not the project id: a purge reseeds the same project's seq numbering
  $effect(() => {
    void ledger.generation
    exhausted = false
    oldestFetched = null
    pinned = true
  })

  const onscroll = (): void => {
    if (!list) return
    pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 60
  }

  // follow the tail only while the operator is at the tail
  $effect(() => {
    void ledger.rows
    if (pinned && list) list.scrollTop = list.scrollHeight
  })

  // seq 1 is the log's first event, so a frontier above it means history exists beyond the pane
  const frontier = $derived(oldestFetched ?? ledger.rows[0]?.seq)
  const older = $derived(frontier !== undefined && frontier > 1 && !exhausted)

  async function loadOlder(): Promise<void> {
    if (frontier === undefined || loadingOlder) return
    // The generation guards the fetch/reseed race: rows from a dead numbering must not fold in
    const project = session.sel.project
    const gen = ledger.generation
    loadingOlder = true
    try {
      let page: ReturnType<typeof dropTicker> = []
      for (let hop = 0; hop < NOISE_CHAIN && page.length === 0; hop++) {
        const before = oldestFetched ?? frontier
        const { data: raw } = await fetchView(project, VIEW.timeline, { scope: { type: ScopeType.project }, beforeSeq: before, limit: OLDER_PAGE })
        if (gen !== ledger.generation) return
        if (!raw || raw.length === 0) {
          exhausted = true
          return
        }
        oldestFetched = raw[0]?.seq ?? before
        // same rule as the live tail: ticker kinds collapse, failures stay
        page = dropTicker(raw, WORKING)
      }
      if (page.length === 0) return
      // anchor on the row being read, measured AFTER the fetch: live appends inflate a pre-fetch height
      const prevHeight = list?.scrollHeight ?? 0
      const prevTop = list?.scrollTop ?? 0
      pinned = false
      ledger.prepend(page)
      await tick()
      if (list) list.scrollTop = prevTop + (list.scrollHeight - prevHeight)
    } catch {
      // surfaced by the api error toast; the button stays for a retry
    } finally {
      loadingOlder = false
    }
  }
</script>

<section aria-label="ledger" class="flex min-h-0 grow flex-col">
  <!-- gates stay pinned above the ledger but BOUNDED: an unbounded block painted over the copilot -->
  <div id="open-gates" class="max-h-[50%] shrink-0 overflow-x-hidden overflow-y-auto">
    {#each operator.state.openQuestions as gate (feedbackKey(gate.taskId, gate.topic))}
      <GateCard {gate} />
    {/each}
  </div>
  <!-- overflow-x-HIDDEN: a log scrolls in time, never sideways; rows truncate instead -->
  <div bind:this={list} {onscroll} class="min-h-0 grow overflow-x-hidden overflow-y-auto">
    {#if ledger.rows.length === 0}
      <p class="px-4 py-6 text-xs text-fog">the ledger fills as the project moves — every event lands here in log order</p>
    {/if}
    {#if older}
      <button
        class="w-full cursor-pointer border-b border-line/50 px-3 py-1.5 text-center font-mono text-label text-fog hover:bg-desk/40 hover:text-mist"
        disabled={loadingOlder}
        onclick={() => void loadOlder()}
      >
        {loadingOlder ? 'loading…' : `load older events (before #${frontier})`}
      </button>
    {/if}
    {#each ledger.rows as row, i (row.seq)}
      <LedgerRow {row} showTask={row.taskId !== ledger.rows[i - 1]?.taskId} />
      {#if row.kind === EVENT_KIND.step_failed && row.taskId !== null && operator.state.retryable.includes(row.taskId)}
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
