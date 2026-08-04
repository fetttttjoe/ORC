<script lang="ts">
  // The sigma island: mounts a WebGL graph over graph.nodes/graph.links and keeps it in sync by
  // diffing deltas — never rebuild-the-world, which is what made the legacy page churn.
  import { MultiGraph } from 'graphology'
  import forceAtlas2 from 'graphology-layout-forceatlas2'
  import FA2Layout from 'graphology-layout-forceatlas2/worker'
  import Sigma from 'sigma'
  import type { Attachment } from 'svelte/attachments'
  import type { GraphNode } from '$lib/api/types'
  import { untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { graph } from '$lib/stores/graph.svelte'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { session } from '$lib/stores/session.svelte'
  import { stepNodeId } from '$lib/node-id'
  import { colorFor, dim, EDGE_COLOR, edgeColorFor, FLASH_COLOR, isActive, LABEL_COLOR } from './colors'

  const SELECTED_RING = 3 // the selected node grows and keeps its full colour while others dim
  const DIM = 0.22 // opacity applied to everything outside the focus set
  const FLASH_MS = 2_400 // how long a node touched by the newest event stays lit
  const BASE_SIZE = 4
  const HEAT_SIZE_SCALE = 4 // a maximally-hot node renders 2x a cold one
  const RUNNING_BUMP = 2 // running reads bigger, not animated — size, no pulse loop
  const EDGE_BASE_SIZE = 1
  const EDGE_HEAT_SIZE_SCALE = 2 // a maximally-hot edge renders 3x a cold one
  const SETTLE_MS = 3_000 // TOTAL layout run per burst of changes — see runLayout
  const FALLBACK_ITERATIONS = 100 // no-Worker environments get one synchronous FA2 pass

  let webglFailed = $state(false)
  let hovered = $state<string | null>(null)

  // Nodes touched by the newest ledger event, lit briefly so the operator SEES where work is
  // happening. Kept out of graphology attributes: this is presentation, and the reducer applies
  // it per frame without mutating the graph the store owns.
  const flashing = new SvelteSet<string>()
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    const row = ledger.rows.at(-1) ?? ledger.working
    if (!row) return
    const touched = [row.noteRef, row.taskId, row.taskId && row.stepId ? stepNodeId(row.taskId, row.stepId) : null].filter(
      (id): id is string => id !== null && id !== undefined,
    )
    if (touched.length === 0) return
    untrack(() => {
      flashing.clear()
      for (const id of touched) flashing.add(id)
    })
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => flashing.clear(), FLASH_MS)
  })

  // Focus mode: the selected task's own subtree stays lit, everything else dims — the graph
  // answers "what does this request touch?" instead of showing the whole project at once.
  const focusSet = $derived.by(() => {
    const root = session.sel.node
    if (root === null || !session.focus) return null
    const keep = new Set<string>([root])
    // walk outward: anything reachable from the selection in either direction is "its" work
    let grew = true
    while (grew) {
      grew = false
      for (const l of graph.links.values()) {
        if (keep.has(l.source) && !keep.has(l.target)) {
          keep.add(l.target)
          grew = true
        } else if (keep.has(l.target) && !keep.has(l.source)) {
          keep.add(l.source)
          grew = true
        }
      }
    }
    return keep
  })

  interface NodeAttrs {
    label: string
    color: string
    size: number
  }
  const nodeAttrs = (n: GraphNode): NodeAttrs => {
    const base = BASE_SIZE + (n.heat ?? 0) * HEAT_SIZE_SCALE
    return {
      label: n.label,
      color: colorFor(n.type, n.detail),
      size: isActive(n.type, n.detail) ? base + RUNNING_BUMP : base,
    }
  }

  const mount: Attachment<HTMLDivElement> = (container) => {
    const g = new MultiGraph()
    let sigma: Sigma
    try {
      sigma = new Sigma(g, container, {
        labelColor: { color: LABEL_COLOR },
        defaultEdgeColor: EDGE_COLOR,
        labelRenderedSizeThreshold: 14, // only nodes that read as landmarks carry a standing label
        labelDensity: 0.5, // sigma drops labels that would collide rather than stacking them
        labelGridCellSize: 140,
        renderLabels: true,
        // the container can be mid-flex-settle (0px) at attach time; the ResizeObserver below
        // picks up the real dimensions, so a zero-size mount must not throw
        allowInvalidContainer: true,
      })
    } catch {
      // no WebGL (headless browser, remote desktop, blocked GPU) — degrade to the placeholder
      webglFailed = true
      return
    }

    // Reducers paint selection/focus/flash per frame. Sigma re-runs them on every render, so
    // these read reactive state without writing a single graph attribute.
    sigma.setSetting('nodeReducer', (id, data) => {
      const selected = id === session.sel.node
      const dimmed = focusSet !== null && !focusSet.has(id)
      const lit = flashing.has(id)
      // a note's title is long and there are hundreds of them: labelling every one turned the
      // canvas into overlapping text. Tasks are what an operator steers by, so they keep theirs.
      const landmark = graph.nodes.get(id)?.type === 'task' || selected || id === hovered
      return {
        ...data,
        ...(landmark ? {} : { label: '' }),
        ...(selected && { size: Number(data['size'] ?? BASE_SIZE) + SELECTED_RING, zIndex: 2 }),
        ...(lit && !selected && { size: Number(data['size'] ?? BASE_SIZE) + 1, zIndex: 1 }),
        ...(lit && { color: FLASH_COLOR }),
        ...(dimmed && !selected && { color: dim(String(data['color'] ?? EDGE_COLOR)), label: '' }),
      }
    })
    sigma.setSetting('edgeReducer', (id, data) => {
      const [src, tgt] = g.extremities(id)
      const dimmed = focusSet !== null && (!focusSet.has(src) || !focusSet.has(tgt))
      return { ...data, ...(dimmed && { color: dim(String(data['color'] ?? EDGE_COLOR)), hidden: false }) }
    })

    // one refresh per change to selection/focus/flash — the reducers do the rest
    $effect(() => {
      void session.sel.node
      void session.focus
      void flashing.size
      void hovered
      sigma.refresh({ skipIndexation: true })
    })

    sigma.on('clickNode', ({ node }) => session.navigate({ node, tab: 'detail' }))
    // hovering reveals the label of whatever is under the cursor, so nothing is unreachable
    sigma.on('enterNode', ({ node }) => {
      container.style.cursor = 'pointer'
      hovered = node
    })
    sigma.on('leaveNode', () => {
      container.style.cursor = ''
      hovered = null
    })

    // sigma only tracks WINDOW resizes; the container resizes without one (flex settling on
    // initial load, panels opening, dock drags) and sigma keeps rendering into stale dimensions.
    // resize() alone never draws — assigning canvas dimensions clears it — so schedule a render.
    const resizeObserver = new ResizeObserver(() => {
      sigma.resize()
      sigma.scheduleRender()
    })
    resizeObserver.observe(container)

    // ---- layout: a BOUNDED settle ----
    let layout: FA2Layout | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const runLayout = (): void => {
      if (g.order === 0) return
      // A run already counting down keeps its deadline. Resetting the timer on every patch is
      // the legacy bug: under sustained load the layout never settled. Bound the TOTAL run;
      // the next change AFTER it stops starts a fresh bounded run.
      if (settleTimer !== null) return
      if (typeof Worker === 'function') {
        layout ??= new FA2Layout(g, { settings: forceAtlas2.inferSettings(g) })
        if (!layout.isRunning()) layout.start()
        settleTimer = setTimeout(() => {
          layout?.stop()
          settleTimer = null
        }, SETTLE_MS)
      } else {
        // no Worker (jsdom, exotic embeds): one synchronous pass instead of a live simulation
        forceAtlas2.assign(g, { iterations: FALLBACK_ITERATIONS, settings: forceAtlas2.inferSettings(g) })
      }
    }

    // ---- reactive sync: diff the store maps against what sigma already knows ----
    const knownNodes = new Set<string>()
    const knownLinks = new Set<string>()

    // A NESTED effect, deliberately: reads of graph.nodes/graph.links are tracked here, not in
    // the attachment itself — tracked in the attachment they would tear sigma down and rebuild
    // it on every patch.
    $effect(() => {
      let changed = false

      // nodes: adds collected first — placement wants already-positioned neighbors
      const fresh: GraphNode[] = []
      for (const [id, n] of graph.nodes) {
        if (!knownNodes.has(id)) {
          fresh.push(n)
          continue
        }
        const attrs = nodeAttrs(n)
        // cheap diff: merge only when a rendered attribute actually moved
        if (
          g.getNodeAttribute(id, 'label') !== attrs.label ||
          g.getNodeAttribute(id, 'color') !== attrs.color ||
          g.getNodeAttribute(id, 'size') !== attrs.size
        )
          g.mergeNodeAttributes(id, attrs)
      }
      if (fresh.length > 0) {
        // new nodes spawn near a linked neighbor (they grow out of their cluster) or at random
        const wanted = new Set(fresh.map((n) => n.id))
        const anchor = new Map<string, string>()
        for (const l of graph.links.values()) {
          if (wanted.has(l.source) && knownNodes.has(l.target)) anchor.set(l.source, l.target)
          if (wanted.has(l.target) && knownNodes.has(l.source)) anchor.set(l.target, l.source)
        }
        for (const n of fresh) {
          const near = anchor.get(n.id)
          const at = near !== undefined && g.hasNode(near)
            ? { x: Number(g.getNodeAttribute(near, 'x')) + (Math.random() - 0.5), y: Number(g.getNodeAttribute(near, 'y')) + (Math.random() - 0.5) }
            : { x: Math.random() * 10, y: Math.random() * 10 }
          g.addNode(n.id, { ...at, ...nodeAttrs(n) })
          knownNodes.add(n.id)
        }
        changed = true
      }
      let droppedNode = false
      for (const id of knownNodes)
        if (!graph.nodes.has(id)) {
          if (g.hasNode(id)) g.dropNode(id) // incident edges drop too
          knownNodes.delete(id)
          droppedNode = true
          changed = true
        }
      // dropNode silently removed incident edges — forget them so a surviving store link
      // (should not happen, but the store is the truth) could be re-added rather than orphaned
      if (droppedNode) for (const key of knownLinks) if (!g.hasEdge(key)) knownLinks.delete(key)

      // links
      for (const [key, l] of graph.links) {
        const heat = l.heat ?? 0
        if (knownLinks.has(key)) {
          // heat-only update: in-place merge, NOT drop+re-add — dropping resets live edge state
          const color = edgeColorFor(heat)
          if (g.getEdgeAttribute(key, 'color') !== color)
            g.mergeEdgeAttributes(key, { color, size: EDGE_BASE_SIZE + heat * EDGE_HEAT_SIZE_SCALE })
        } else if (g.hasNode(l.source) && g.hasNode(l.target)) {
          g.addEdgeWithKey(key, l.source, l.target, {
            color: edgeColorFor(heat),
            size: EDGE_BASE_SIZE + heat * EDGE_HEAT_SIZE_SCALE,
          })
          knownLinks.add(key)
          changed = true
        }
      }
      for (const key of knownLinks)
        if (!graph.links.has(key)) {
          if (g.hasEdge(key)) g.dropEdge(key)
          knownLinks.delete(key)
          changed = true
        }

      if (changed) runLayout()
    })

    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer)
      layout?.kill()
      resizeObserver.disconnect()
      sigma.kill()
    }
  }
</script>

{#if webglFailed}
  <div class="grid h-full w-full place-items-center text-xs text-mist">graph view needs WebGL, which this browser did not provide</div>
{:else}
  <div class="h-full w-full" {@attach mount}></div>
{/if}
