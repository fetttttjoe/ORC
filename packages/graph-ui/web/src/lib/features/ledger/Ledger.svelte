<script lang="ts">
  import { tick } from 'svelte'
  import GateCard from '$lib/features/gates/GateCard.svelte'
  import LedgerRow from './LedgerRow.svelte'
  import RetryRow from './RetryRow.svelte'
  import WorkingLine from './WorkingLine.svelte'
  import PlanCard from './PlanCard.svelte'
  import { api } from '$lib/api/client'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { session } from '$lib/stores/session.svelte'
  import { dropTicker } from '$lib/stores/ledger-merge'
  import { EVENT_KIND, WORKING } from '$lib/event-kinds'

  // one backward page — the same window the boot load uses, so paging feels like more of the same
  const OLDER_PAGE = 150
  // ticker-only pages auto-chain up to this many fetches per click, so a burst of agent-loop
  // noise does not turn the button into a click-that-does-nothing; past it the click still
  // advanced the cursor, and the next click resumes from there
  const NOISE_CHAIN = 5

  let list = $state<HTMLElement | null>(null)
  let pinned = $state(true)
  let loadingOlder = $state(false)
  // flips when a page comes back empty — the log has no rows before the pane's first
  let exhausted = $state(false)
  // Where paging has actually reached. The rendered rows cannot carry this: a fetched page that
  // was ALL ticker noise prepends nothing, and keying the next request off rows[0] would re-fetch
  // the same page forever.
  let oldestFetched = $state<number | null>(null)

  // Paging state belongs to one pane GENERATION — one seq numbering — and this component
  // outlives them all (App mounts it once, unkeyed). Keyed on ledger.generation rather than the
  // project id: a purge or seq regression reseeds the SAME project's numbering via
  // ledger.reset(), and project-keyed state kept a cursor pointing into the dead numbering
  // (and a stuck `exhausted` hid the button over real history).
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
    // The fetch races a pane reseed — project switch, purge, seq regression. The generation is
    // the guard, not the project id: rows fetched for a dead numbering must neither fold into
    // the new pane (mergeOlder cannot catch it — foreign seqs pass its head guard) nor write
    // exhausted/cursor state the new generation would inherit.
    const project = session.sel.project
    const gen = ledger.generation
    loadingOlder = true
    try {
      let page: ReturnType<typeof dropTicker> = []
      for (let hop = 0; hop < NOISE_CHAIN && page.length === 0; hop++) {
        const before = oldestFetched ?? frontier
        const raw = await api.log(project, { beforeSeq: before, limit: OLDER_PAGE })
        if (gen !== ledger.generation) return
        if (raw.length === 0) {
          exhausted = true
          return
        }
        oldestFetched = raw[0]?.seq ?? before
        // same rule as the live tail: ticker kinds collapse, failures stay
        page = dropTicker(raw, WORKING)
      }
      if (page.length === 0) return
      // anchor the viewport on the row the operator was reading — measured AFTER the fetch:
      // live rows appended during the await inflate a pre-fetch measurement and over-scroll
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
  <!-- gates stay pinned above the ledger, but BOUNDED: an unbounded block grew past the pane on
       a long question and painted over the copilot below it. Half the height at most, and its
       own scroll for the rest. -->
  <div id="open-gates" class="max-h-[50%] shrink-0 overflow-x-hidden overflow-y-auto">
    {#each ledger.gates as gate (gate.taskId)}
      <GateCard {gate} />
    {/each}
  </div>
  <!-- overflow-x-HIDDEN, not auto: a log scrolls in time, never sideways. Without it a single
       long id or summary widened the whole column and every row gained a horizontal scrollbar,
       which moves the seq spine off-screen and hides the one thing the ledger is read by. Rows
       truncate instead (each carries min-w-0 + truncate), so width is bounded by the pane. -->
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
