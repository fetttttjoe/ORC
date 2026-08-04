<script lang="ts">
  import StatusPill from '$lib/components/StatusPill.svelte'
  import { cn } from '$lib/utils'
  import { statusTemperature, TEMP_BORDER, TEMP_DOT, TEMP_TEXT } from '$lib/temperature'
  import { stepNodeId } from '$lib/node-id'
  import { session } from '$lib/stores/session.svelte'
  import { STEP_STATUS, waveState } from './plan-status'
  import type { WaveStep } from '$lib/api/types'

  /**
   * A plan as it EXECUTES: waves down the page, the steps of a wave side by side because they run
   * side by side, and a rail whose colour says how far the run has got. The old chip rows said
   * what the steps were called but not what the shape meant — which wave gates which, what is
   * running now, what is left.
   *
   * Deliberately not a node-link diagram: a frozen plan is a sequence of parallel waves, and
   * drawing it as one loses the only structure that matters at a glance.
   */
  let {
    taskId,
    waves,
    compact = false,
  }: {
    taskId: string
    waves: readonly { wave: number; parallel: boolean; steps: readonly WaveStep[] }[]
    /** the ledger card shows less than the inspector does */
    compact?: boolean
  } = $props()

  const RUNNING = STEP_STATUS.running
</script>

<ol class="flex flex-col">
  {#each waves as wave, i (wave.wave)}
    {@const state = waveState(wave.steps.map(s => s.status))}
    {@const temp = statusTemperature(state)}
    <li class="flex gap-2">
      <!-- the rail: filled as far as the run has got, so progress reads vertically -->
      <div class="flex w-6 shrink-0 flex-col items-center">
        <span class={cn('mt-1.5 size-2 shrink-0 rounded-[3px] transition-colors', TEMP_DOT[temp])}></span>
        {#if i < waves.length - 1}
          <span class={cn('w-px grow transition-colors', state === 'completed' ? 'bg-moss/50' : 'bg-line')}></span>
        {/if}
      </div>

      <div class={cn('mb-2 min-w-0 grow border-l-2 pl-2.5', TEMP_BORDER[temp])}>
        <div class="mb-1 flex items-baseline gap-2">
          <span class={cn('font-mono text-label tracking-widest uppercase', TEMP_TEXT[temp])}>wave {wave.wave}</span>
          <span class="font-mono text-label text-fog">
            {wave.steps.length === 1 ? 'alone' : `${wave.steps.length} in parallel`}
          </span>
          {#if i > 0}<span class="font-mono text-label text-fog/70">after wave {waves[i - 1]?.wave}</span>{/if}
        </div>

        <div class={cn('grid gap-1', compact ? 'grid-cols-1' : 'sm:grid-cols-2')}>
          {#each wave.steps as step (step.id)}
            <button
              class={cn(
                'flex min-w-0 items-center gap-1.5 rounded-(--radius-chip) border px-2 py-1 text-left transition-colors',
                'border-line bg-desk/40 hover:border-rule hover:bg-desk',
                step.status === RUNNING && 'border-machine/45 bg-machine/8',
                step.status === 'failed' && 'border-rust/45 bg-rust/8',
              )}
              title="open step in inspector"
              onclick={() => session.navigate({ node: stepNodeId(taskId, step.id), tab: 'detail' })}
            >
              <span class={cn('size-1.5 shrink-0 rounded-full', TEMP_DOT[statusTemperature(step.status)], step.status === RUNNING && 'breathe')}></span>
              <span class="min-w-0 grow truncate text-row text-paper" title={step.title}>{step.title}</span>
              {#if !compact}<StatusPill status={step.status} />{/if}
            </button>
          {/each}
        </div>
      </div>
    </li>
  {/each}
</ol>
