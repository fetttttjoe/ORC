<script lang="ts">
  import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte'

  /**
   * Re-fit the viewport when the canvas becomes fittable. SvelteFlow's own `fitView` prop fits
   * once, at mount — mounted inside a still-settling flex column or an opening collapsible the
   * container measures 0×0, the computed transform lands every node outside the clipped box, and
   * the operator stares at an empty canvas until a manual fit-view click (observed live on the
   * request tab's dependency graph).
   *
   * Refits ONLY when a fit input actually changes — nodes finish measuring, the node set's
   * IDENTITY reshapes (`shape` is the joined ids, so an equal-count swap refits too — a bare
   * count key did not), or the container crosses from unmeasurable to measurable while unfitted.
   * A plain resize leaves `measurable` true and must not refit: that would yank a viewport the
   * operator has panned.
   */
  let { shape, measurable, padding }: { shape: string; measurable: boolean; padding: number } = $props()

  const inited = useNodesInitialized()
  const { fitView } = useSvelteFlow()

  // NOT $state: fitView() itself rewrites the flow's nodes array, which flaps nodesInitialized —
  // an unguarded effect tracking `inited.current` refits on its own write, forever. The loop's
  // perpetual store writes also kept an outroing plan panel alive, so "hide dependency graph"
  // stopped hiding anything (caught by the collapse e2e).
  let fitted = ''

  $effect(() => {
    if (!measurable || !inited.current || fitted === shape) return
    fitted = shape
    void fitView({ padding })
  })
</script>
