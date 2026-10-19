<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { SUPERVISOR_HEALTH } from '@orc/contracts/health'
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
   * So: an indeterminate bar, the reason in
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

  // How long since the supervisor last said it was alive. Null when it has never reported one —
  // absent evidence, which must not render as "0s ago" and claim a heartbeat that never arrived.
  const beatAge = $derived.by<number | null>(() => {
    const at = sup?.lastSeenAt === undefined ? NaN : Date.parse(sup.lastSeenAt)
    return Number.isFinite(at) ? Math.max(0, now - at) : null
  })

  interface Banner {
    title: string
    detail: string
    temp: Temperature
  }

  const banner = $derived.by<Banner | null>(() => {
    if (sup?.state === SUPERVISOR_HEALTH.booting)
      return {
        title: 'supervisor starting',
        // The banner's whole job is telling a long boot from a hang, and the sentence alone could
        // not: it read identically at second 2 and minute 5. The heartbeat is the evidence — it is
        // written by the boot loop itself, so an advancing age proves the process is still working
        // and a frozen one is the first thing an operator can act on.
        detail:
          beatAge === null
            ? 'it recovers any interrupted work before accepting runs.'
            : beatAge > STALE_BEAT_MS
              ? `it is recovering interrupted work before accepting runs — but its heartbeat has not moved for ${ago(beatAge)}, which is longer than a healthy boot goes silent. Check the supervisor process${sup.pid === undefined ? '' : ` (pid ${sup.pid})`}.`
              : 'it recovers any interrupted work before accepting runs — a long boot means it found work to finish, not that it hung.',
        temp: beatAge !== null && beatAge > STALE_BEAT_MS ? 'rust' : 'human',
      }

    // A client holds the execution runtime — a `--no-daemon` command or the graph server. Work IS
    // running, so this must not read like the two rust states below it.
    if (sup?.state === SUPERVISOR_HEALTH.client)
      return {
        title: 'a client is driving this project',
        detail: 'no background supervisor, but something holds the execution runtime — a foreground `orc` command or this graph server. Runs execute while it lives.',
        temp: 'machine',
      }

    if (sup?.state === SUPERVISOR_HEALTH.stale)
      return {
        title: 'supervisor stopped without cleaning up',
        detail: 'nothing is driving runs. Start one with `orc serve`, or any orc command will spawn it.',
        temp: 'rust',
      }

    if (sup?.state === SUPERVISOR_HEALTH.none)
      return {
        title: 'no supervisor is running',
        detail: 'requests can be written and approved, but nothing will execute until one starts (`orc serve`).',
        temp: 'rust',
      }

    return null
  })

</script>

{#if banner}
  <section class="flex shrink-0 flex-col gap-1 border-b border-line bg-bureau px-3 py-2" aria-label="system status" aria-live="polite">
    <div class="flex items-baseline gap-2">
      <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[banner.temp])}>{banner.title}</span>
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
    <Progress class="h-1 animate-pulse" aria-label={banner.title} />
    <p class="text-row leading-relaxed text-mist">{banner.detail}</p>
  </section>
{/if}
