<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { MEMORY_HEALTH } from '@orc/contracts/health'
  import { MEMORY_STAGE, MemoryStageName, SUPERVISOR_HEALTH } from '@orc/contracts/health'
  import { Progress } from '$lib/components/ui/progress'
  import { api } from '$lib/api/client'
  import { healthKey } from '$lib/api/view-client'
  import { cn } from '$lib/utils'
  import { session } from '$lib/stores/session.svelte'
  import type { Temperature } from '$lib/temperature'
  import { TEMP_TEXT } from '$lib/temperature'

  /**
   * What the system is doing when it cannot yet do what you asked.
   *
   * A chip reading "supervisor booting" is true and useless: it never says why, whether it is
   * moving, or what to do. Measured live — a supervisor sat in boot for minutes recovering an
   * interrupted workflow while the operator had no way to tell that from a hang.
   *
   * So: a bar (determinate where a real number exists, indeterminate otherwise), the reason in
   * plain words, and the action when there is one. It shows only while something is transitional
   * and disappears the moment the system is ready — a permanent banner teaches people to skip it.
   */
  const POLL_MS = 3_000
  // A boot writes its heartbeat well inside this; past it, silence is the story worth telling.
  const STALE_BEAT_MS = 20_000
  const TICK_MS = 1_000

  /** a clock that advances between polls, so the heartbeat age counts up instead of stepping */
  let now = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), TICK_MS)
    return () => clearInterval(t)
  })

  const ago = (ms: number): string => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`)

  const health = createQuery(() => ({
    queryKey: healthKey(session.sel.project),
    queryFn: api.health,
    // faster than the header's 15s poll: this banner exists for the minutes when things move
    refetchInterval: POLL_MS,
  }))

  const sup = $derived(health.data?.supervisor)
  const mem = $derived(health.data?.memory)

  // remember the deepest backlog seen so the bar measures progress against where it started
  let peak = $state(0)
  $effect(() => {
    const pending = mem?.state === MEMORY_HEALTH.catchingUp ? mem.pending : 0
    if (pending > peak) peak = pending
    if (pending === 0) peak = 0
  })

  // How long since the supervisor last said it was alive. Null when it has never reported one —
  // absent evidence, which must not render as "0s ago" and claim a heartbeat that never arrived.
  const beatAge = $derived.by<number | null>(() => {
    const at = sup?.lastSeenAt === undefined ? NaN : Date.parse(sup.lastSeenAt)
    return Number.isFinite(at) ? Math.max(0, now - at) : null
  })

  // The boot's real work is replaying the projection, and `pending` is how much of it is left —
  // the same number the catch-up banner below charts, surfaced during boot where it answers
  // "is this moving?" rather than only after the supervisor is already up.
  const backlog = $derived(mem?.state === MEMORY_HEALTH.catchingUp && mem.pending > 0 ? mem.pending : null)

  // What it is ACTUALLY doing. `pending` covers the event replay only — the stages after it
  // (re-linking every note's edges, re-partitioning the claim corpus through ollama) run with
  // pending already at zero, which is why a long boot used to show one unchanging sentence.
  // keyed by the contract's own stage names, and Record<MemoryStageName,...> makes a stage added
  // there a compile error here rather than a raw enum value leaking onto the screen
  const STAGE_SAID: Record<MemoryStageName, string> = {
    [MEMORY_STAGE.replaying]: 'replaying knowledge events',
    [MEMORY_STAGE.linking]: 're-linking the knowledge graph',
    [MEMORY_STAGE.clustering]: 're-clustering claims through the embedder',
  }
  // The boot pipeline as a SEGMENTED track: replay → link → cluster, in the contract's own stage
  // order (one spelling — MemoryStageName.options is the sequence the projector actually runs).
  // Rendered only while BOOTING with a live stage: during a live-path refresh the earlier
  // segments did not run, and a track showing them "done" would be a lie about work nobody did.
  const STAGE_ORDER = MemoryStageName.options
  const SEGMENT_LABEL: Record<MemoryStageName, string> = {
    [MEMORY_STAGE.replaying]: 'replay',
    [MEMORY_STAGE.linking]: 'link',
    [MEMORY_STAGE.clustering]: 'cluster',
  }
  const activeIdx = $derived(mem?.stage ? STAGE_ORDER.indexOf(mem.stage.name) : -1)
  const bootTrack = $derived(sup?.state === SUPERVISOR_HEALTH.booting && activeIdx >= 0)
  /** a segment's fill: 100 behind the active stage, the replay's own count inside it, null = active-indeterminate */
  const segmentPct = (i: number): number | null => {
    if (i < activeIdx) return 100
    if (i > activeIdx) return 0
    const c = counted
    return c && c.total > 0 ? Math.min(100, Math.round((c.applied / c.total) * 100)) : null
  }
  // The replaying stage carries its own count, and saying it matters: a stage line WITHOUT one
  // ("replaying knowledge events (40s so far)") replaced the quantitative "N events left to
  // replay" this banner used to show, trading the one number that answers "is it moving?" for a
  // label. Where the publisher counted, the count is shown.
  const counted = $derived(mem?.stage?.progress ?? null)
  const work = $derived(
    mem?.stage
      ? ` Currently ${STAGE_SAID[mem.stage.name] ?? mem.stage.name}${counted ? ` — ${counted.applied}/${counted.total}` : ''} (${ago(mem.stage.sinceMs)} so far).`
      : backlog === null ? '' : ` ${backlog} events left to replay.`,
  )
  // Prefer the REPLAY's own applied/total over the pending-vs-peak estimate: `peak` is the largest
  // backlog this tab happened to observe, so a tab opened mid-drain starts its denominator low and
  // reads far too optimistic. The published pair is the projector's own count of the drain it is
  // actually running, and it needs no observation history to be right.
  const bootPercent = $derived(
    counted && counted.total > 0 ? Math.min(100, Math.round((counted.applied / counted.total) * 100))
      : backlog !== null && peak > 0 ? Math.min(100, Math.round(((peak - backlog) / peak) * 100))
        : null,
  )

  interface Banner {
    title: string
    detail: string
    temp: Temperature
    /** 0–100 when a real measurement exists; null renders the indeterminate sweep */
    percent: number | null
  }

  const banner = $derived.by<Banner | null>(() => {
    if (mem?.state === MEMORY_HEALTH.unreachable)
      return {
        title: 'knowledge store unreachable',
        detail: mem.reason ?? 'runs still execute, but agents cannot read or write notes until it returns.',
        temp: 'rust',
        percent: null,
      }

    if (sup?.state === SUPERVISOR_HEALTH.booting)
      return {
        title: 'supervisor starting',
        // The banner's whole job is telling a long boot from a hang, and the sentence alone could
        // not: it read identically at second 2 and minute 5. The heartbeat is the evidence — it is
        // written by the boot loop itself, so an advancing age proves the process is still working
        // and a frozen one is the first thing an operator can act on.
        detail:
          beatAge === null
            ? 'it replays the projection and recovers any interrupted work before accepting runs.'
            : beatAge > STALE_BEAT_MS
              ? `it replays the projection before accepting runs — but its heartbeat has not moved for ${ago(beatAge)}, which is longer than a healthy boot goes silent. Check the supervisor process${sup.pid === undefined ? '' : ` (pid ${sup.pid})`}.`
              : `it replays the projection and recovers any interrupted work before accepting runs — a long boot means it found work to finish, not that it hung.${work}`,
        temp: beatAge !== null && beatAge > STALE_BEAT_MS ? 'rust' : 'human',
        percent: bootPercent,
      }

    // A client holds the execution runtime — a `--no-daemon` command or the graph server. Work IS
    // running, so this must not read like the two rust states below it.
    if (sup?.state === SUPERVISOR_HEALTH.client)
      return {
        title: 'a client is driving this project',
        detail: 'no background supervisor, but something holds the execution runtime — a foreground `orc` command or this graph server. Runs execute while it lives.',
        temp: 'machine',
        percent: null,
      }

    if (sup?.state === SUPERVISOR_HEALTH.stale)
      return {
        title: 'supervisor stopped without cleaning up',
        detail: 'nothing is driving runs. Start one with `orc serve`, or any orc command will spawn it.',
        temp: 'rust',
        percent: null,
      }

    if (sup?.state === SUPERVISOR_HEALTH.none)
      return {
        title: 'no supervisor is running',
        detail: 'requests can be written and approved, but nothing will execute until one starts (`orc serve`).',
        temp: 'rust',
        percent: null,
      }

    if (mem?.state === MEMORY_HEALTH.catchingUp && mem.pending > 0)
      return {
        // The count rides in the DETAIL, not the title: the uppercase tracking-widest title wraps
        // one word per line when the inspector squeezes this pane (observed live at ~240px), and
        // a six-line banner buries the ledger it sits above. The detail line wraps like prose.
        title: 'knowledge graph catching up',
        detail: `${mem.pending} ${mem.pending === 1 ? 'event' : 'events'} behind — runs execute normally; notes and drift readings lag until it lands.`,
        temp: 'machine',
        // pending only ever shrinks toward zero, so its own peak is the honest denominator
        percent: peak > 0 ? Math.min(100, Math.round(((peak - mem.pending) / peak) * 100)) : null,
      }

    return null
  })

</script>

{#if banner}
  <section class="flex shrink-0 flex-col gap-1 border-b border-line bg-bureau px-3 py-2" aria-label="system status" aria-live="polite">
    <div class="flex items-baseline gap-2">
      <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[banner.temp])}>{banner.title}</span>
      {#if banner.percent !== null}<span class="font-mono text-label text-fog">{banner.percent}%</span>{/if}
      <span class="grow"></span>
      <!-- the liveness tell: an age that counts up every second is a process still running, and a
           frozen one is the difference between a slow boot and a dead one -->
      {#if beatAge !== null && banner.temp !== 'rust'}
        <span class="flex shrink-0 items-center gap-1 font-mono text-label text-fog tabular-nums">
          <span class={cn('size-1 rounded-full', beatAge > STALE_BEAT_MS ? 'bg-rust' : 'bg-moss breathe')}></span>
          heartbeat {ago(beatAge)} ago
        </span>
      {/if}
    </div>
    {#if bootTrack}
      <!-- the whole boot at a glance: done segments full, the active one filled by its own count
           (or pulsing where the stage has no unit), the rest waiting — an operator sees WHERE the
           boot is, not just that one exists -->
      <div class="flex items-center gap-1" role="progressbar" aria-label="boot pipeline">
        {#each STAGE_ORDER as name, i (name)}
          {@const pct = segmentPct(i)}
          <div class="flex grow flex-col gap-0.5">
            <div class="h-1 overflow-hidden rounded-full bg-line">
              <div
                class={cn('h-full rounded-full bg-moss', pct === null && 'w-full animate-pulse opacity-50')}
                style={pct === null ? undefined : `width: ${pct}%`}
              ></div>
            </div>
            <span class={cn('font-mono text-label', i === activeIdx ? 'text-mist' : 'text-fog')}>{SEGMENT_LABEL[name]}</span>
          </div>
        {/each}
      </div>
    {:else}
      <Progress
        value={banner.percent ?? undefined}
        class={cn('h-1', banner.percent === null && 'animate-pulse')}
        aria-label={banner.title}
      />
    {/if}
    <p class="text-row leading-relaxed text-mist">{banner.detail}</p>
  </section>
{/if}
