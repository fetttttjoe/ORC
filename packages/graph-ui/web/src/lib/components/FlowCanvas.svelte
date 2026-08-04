<script lang="ts">
  import { SvelteFlow, Background, Controls, type Edge, type EdgeTypes, type Node, type NodeTypes } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/base.css'

  /**
   * A Svelte Flow canvas with this console's chrome on it, and NOTHING about what it draws. It
   * takes nodes, edges and the components that render them; it does not know what a plan, a step
   * or a wave is.
   *
   * That split is the point: the plan graph, a decomposition graph, or an editor all differ in
   * their ADAPTER (domain → nodes/edges), not in their canvas. Every previous graph surface here
   * fused the two and had to be rewritten whenever either half changed.
   *
   * Deliberately NOT a replacement for GraphIsland: sigma renders the 455-node project graph on
   * WebGL with a force layout, which is a different problem from a dozen laid-out DOM nodes.
   */
  interface Props {
    nodes: Node[]
    edges: Edge[]
    nodeTypes?: NodeTypes | undefined
    edgeTypes?: EdgeTypes | undefined
    /** css height for the canvas box; the caller owns sizing because only it knows its container */
    height: string
    /** allow dragging new connections between handles — the editor's switch */
    connectable?: boolean | undefined
    onnodeclick?: ((id: string) => void) | undefined
    onconnect?: ((from: string, to: string) => void) | undefined
    /** rendered instead of the canvas when there is nothing to draw */
    empty?: string | undefined
    /** accessible name for the canvas region — also what an e2e selector reaches for */
    label: string
  }

  let {
    nodes,
    edges,
    nodeTypes = {},
    edgeTypes = {},
    height,
    connectable = false,
    onnodeclick,
    onconnect,
    empty = 'nothing to draw',
    label,
  }: Props = $props()
</script>

{#if nodes.length === 0}
  <p class="text-xs text-fog">{empty}</p>
{:else}
  <div
    class="orc-flow overflow-hidden rounded-(--radius-card) border border-line bg-ink/40"
    style:height
    role="group"
    aria-label={label}
  >
    <SvelteFlow
      {nodes}
      {edges}
      {nodeTypes}
      {edgeTypes}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.12 }}
      nodesConnectable={connectable}
      elementsSelectable={connectable}
      nodesDraggable={false}
      preventScrolling={false}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: false }}
      onnodeclick={({ node }) => onnodeclick?.(node.id)}
      onconnect={({ source, target }) => {
        if (source && target) onconnect?.(source, target)
      }}
    >
      <Background gap={18} />
      <Controls showLock={false} position="bottom-right" />
    </SvelteFlow>
  </div>
{/if}

<style>
  /* Svelte Flow ships structural CSS only; the palette is ours. Scoped to this wrapper so the
     tokens cannot leak into any other surface that later embeds a canvas. */
  .orc-flow :global(.svelte-flow) {
    --xy-background-color: transparent;
    --xy-edge-stroke: var(--color-rule);
    --xy-edge-stroke-selected: var(--color-machine);
    --xy-handle-background-color: var(--color-machine);
    --xy-handle-border-color: var(--color-ink);
    --xy-controls-button-background-color: var(--color-desk);
    --xy-controls-button-background-color-hover: var(--color-rule);
    --xy-controls-button-color: var(--color-mist);
    --xy-controls-button-color-hover: var(--color-paper);
    --xy-controls-button-border-color: var(--color-line);
  }
  /* the dotted background reads as noise at full strength against this theme */
  .orc-flow :global(.svelte-flow__background) {
    opacity: 0.35;
  }
  /* a group container must not paint over its children */
  .orc-flow :global(.svelte-flow__node[data-id^='wave:']) {
    background: transparent;
    border: none;
  }
</style>
