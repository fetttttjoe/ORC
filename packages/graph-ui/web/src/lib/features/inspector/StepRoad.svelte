<script lang="ts">
  import { displayInstructions } from '@orc/contracts/check-commands'
  import * as Card from '$lib/components/ui/card'
  import { Separator } from '$lib/components/ui/separator'
  import Chip from '$lib/components/Chip.svelte'
  import NodeLink from '$lib/components/NodeLink.svelte'
  import StatusPill from '$lib/components/StatusPill.svelte'
  import { stepNodeId } from '$lib/node-id'
  import { statusTemperature, TEMP_DOT } from '$lib/temperature'
  import { cn } from '$lib/utils'
  import { topoOrder } from './topo'
  import type { PlanStepView, WaveStep } from '$lib/api/types'

  // Every step in execution order: what it runs on, what it waits for, how it went
  let { taskId, steps, states }: { taskId: string; steps: readonly PlanStepView[]; states: readonly WaveStep[] } = $props()

  const statusOf = $derived(new Map(states.map(s => [s.id, s.status])))
  const ordered = $derived(topoOrder(steps))
</script>

<div class="flex flex-col">
  {#each ordered as step, i (step.id)}
    {@const status = statusOf.get(step.id) ?? 'pending'}
    <div class="flex gap-2">
      <!-- the rail: a marker per step, connected except at the end -->
      <div class="flex w-3 shrink-0 flex-col items-center pt-2">
        <span class={cn('size-1.5 shrink-0 rounded-full', TEMP_DOT[statusTemperature(status)])}></span>
        {#if i < ordered.length - 1}<span class="w-px grow bg-line"></span>{/if}
      </div>

      <Card.Root class="mb-1.5 min-w-0 grow gap-0 border-line bg-desk/30 py-2">
        <Card.Header class="gap-1 px-3">
          <div class="flex min-w-0 items-center gap-2">
            <NodeLink node={stepNodeId(taskId, step.id)} label={step.title} />
            <span class="grow"></span>
            <StatusPill {status} />
          </div>
          <div class="flex flex-wrap items-center gap-1">
            {#if step.role}<Chip mono>{step.role}</Chip>{/if}
            {#if step.modelRef}<Chip mono title={step.modelRef}>{step.modelRef}</Chip>{/if}
            {#if step.zone.length > 0}<Chip mono title={step.zone.join(', ')}>{step.zone.length} zone{step.zone.length === 1 ? '' : 's'}</Chip>{/if}
            {#each step.skillRefs as skill (skill)}<Chip mono temp="machine" title="the contract this step runs under">{skill}</Chip>{/each}
            {#if step.maxIterations !== undefined}<Chip mono title="the step stops itself at this many agent turns">≤{step.maxIterations} iter</Chip>{/if}
          </div>
          {#if step.dependsOn.length > 0}
            <p class="flex flex-wrap items-baseline gap-1 text-row text-fog">
              after
              {#each step.dependsOn as dep (dep)}
                <NodeLink node={stepNodeId(taskId, dep)} label={dep} />
              {/each}
            </p>
          {/if}
        </Card.Header>

        {#if step.instructions}
          <Card.Content class="px-3 pt-1">
            <Separator class="mb-1.5" />
            <details>
              <summary class="cursor-pointer font-mono text-label tracking-widest text-fog uppercase select-none">instructions</summary>
              <p class="mt-1 text-row leading-relaxed break-words whitespace-pre-wrap text-mist">{displayInstructions(step)}</p>
            </details>
          </Card.Content>
        {/if}
      </Card.Root>
    </div>
  {/each}
</div>
