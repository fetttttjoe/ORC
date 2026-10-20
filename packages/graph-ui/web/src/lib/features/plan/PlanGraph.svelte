<script lang="ts">
  import FlowCanvas from '$lib/components/FlowCanvas.svelte'
  import PlanStepNode from './PlanStepNode.svelte'
  import WaveNode from './WaveNode.svelte'
  import { planToFlow, type FlowStep } from './plan-flow'
  import { linkRefusal, linkSteps, type EditableStep } from './plan-edit'
  import { DEFAULT_GEOMETRY } from './plan-geometry'

  // The plan as a DAG in waves; thin on purpose: logic lives in plan-flow, FlowCanvas and plan-edit
  interface Props {
    steps: readonly (FlowStep & EditableStep)[]
    /** run status per step id; anything missing is pending */
    statusOf?: ((id: string) => string | undefined) | undefined
    onstepclick?: ((stepId: string) => void) | undefined
    /** supply to make the graph editable — receives the rewired steps, or a refusal to report */
    onlink?: ((next: (FlowStep & EditableStep)[]) => void) | undefined
    onrefused?: ((reason: string) => void) | undefined
    /** fill the container instead of sizing to the drawing — the expanded/dialog presentation */
    expanded?: boolean | undefined
  }

  let { steps, statusOf, onstepclick, onlink, onrefused, expanded = false }: Props = $props()

  const flow = $derived(planToFlow(steps, { statusOf, editable: onlink !== undefined }))

  // Inline the canvas is bounded to its drawing; expanded it fills the box the dialog gives it
  const height = $derived(
    expanded ? '100%' : `${Math.min(460, Math.max(180, flow.height + DEFAULT_GEOMETRY.padTop * 2))}px`,
  )

  const connect = (from: string, to: string): void => {
    const refusal = linkRefusal(steps, from, to)
    if (refusal !== null) {
      onrefused?.(refusal)
      return
    }
    onlink?.(linkSteps(steps, from, to))
  }
</script>

<FlowCanvas
  nodes={flow.nodes}
  edges={flow.edges}
  nodeTypes={{ step: PlanStepNode, wave: WaveNode }}
  {height}
  connectable={onlink !== undefined}
  onnodeclick={onstepclick}
  onconnect={connect}
  empty="this plan has no steps to draw"
  label="plan dependency graph"
/>
