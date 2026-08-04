<script lang="ts">
  import FlowCanvas from '$lib/components/FlowCanvas.svelte'
  import PlanStepNode from './PlanStepNode.svelte'
  import WaveNode from './WaveNode.svelte'
  import { planToFlow, type FlowStep } from './plan-flow'
  import { linkRefusal, linkSteps, type EditableStep } from './plan-edit'
  import { DEFAULT_GEOMETRY } from './plan-geometry'

  /**
   * The plan as a DAG, in waves. Answers what the rail cannot: which step gates which.
   *
   * Thin ON PURPOSE — it composes plan-flow (adapter), FlowCanvas (renderer) and plan-edit (rules),
   * and holds no logic of its own. Everything a test would want to assert lives in one of those
   * three, none of which needs a browser.
   *
   * `onlink` is the pre-approval editor's seam: pass it and the canvas grows connection handles,
   * the cycle guard runs, and the caller receives the NEW step array to persist through the `edit`
   * action. Leave it off and this is a read-only picture. Nothing else changes between the two.
   */
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

  // Inline, the canvas is sized to its own drawing and bounded, so a wide plan cannot push the
  // rest of the inspector off the pane. Expanded, it fills whatever box the caller gives it —
  // the dialog owns the height there, because only it knows the viewport.
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
