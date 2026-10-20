<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import { statusTemperature, TEMP_DOT } from '$lib/temperature'
  import { cn } from '$lib/utils'
  import { STEP_STATUS } from './plan-status'
  import type { StepNodeData } from './plan-flow'

  // One step in the wave rail's chip vocabulary; handles are invisible until editable
  let { data }: NodeProps = $props()
  const step = $derived(data as StepNodeData)
</script>

<Handle type="target" position={Position.Left} class={step.editable ? '' : '!pointer-events-none !opacity-0'} />

<div
  class={cn(
    'flex h-full w-full items-center gap-1.5 rounded-(--radius-chip) border px-2 transition-colors',
    'border-line bg-ink/90 hover:border-rule',
    step.status === STEP_STATUS.running && 'border-machine/45 bg-machine/8',
    step.status === STEP_STATUS.failed && 'border-rust/45 bg-rust/8',
  )}
  title={step.title}
>
  <span
    class={cn('size-1.5 shrink-0 rounded-full', TEMP_DOT[statusTemperature(step.status)], step.status === STEP_STATUS.running && 'breathe')}
  ></span>
  <span class="min-w-0 grow truncate text-row text-paper">{step.title}</span>
</div>

<Handle type="source" position={Position.Right} class={step.editable ? '' : '!pointer-events-none !opacity-0'} />
