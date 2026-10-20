<script lang="ts">
  import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte'

  // Refit when the canvas becomes fittable: fitView fits once at mount, when the box may measure 0x0
  let { shape, measurable, padding }: { shape: string; measurable: boolean; padding: number } = $props()

  const inited = useNodesInitialized()
  const { fitView } = useSvelteFlow()

  // NOT $state: fitView rewrites the nodes array, so tracking it would refit on its own write forever
  let fitted = ''

  $effect(() => {
    if (!measurable || !inited.current || fitted === shape) return
    fitted = shape
    void fitView({ padding })
  })
</script>
