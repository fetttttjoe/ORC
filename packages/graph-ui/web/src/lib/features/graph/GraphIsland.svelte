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
  import ScanIcon from '@lucide/svelte/icons/scan'
  import { stepNodeId, taskIdOf } from '$lib/node-id'
  import { colorFor, dim, EDGE_COLOR, edgeColorFor, FLASH_COLOR, isActive, LABEL_COLOR, TYPE_COLORS } from './colors'
  import { focusReach } from './focus'

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
  // the mounted renderer, for the reset control — imperative-only, so not $state
  let sigmaRef: Sigma | null = null
  // whether the operator has taken the camera — set by mount()'s listeners, cleared by the
  // reset control (resetting IS opting back into auto-framing). imperative-only, not $state.
  let cameraTouched = false

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
  // The walk lives in focus.ts (directed, outward-only); rooted at the OWNING task so focusing
  // while a step or artifact is selected still lights the whole request.
  const focusSet = $derived.by(() => {
    const sel = session.sel.node
    if (sel === null || !session.focus) return null
    return focusReach(taskIdOf(sel) ?? sel, graph.links.values())
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
    sigmaRef = sigma

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

    // The operator takes the camera with wheel-zoom, drag-pan, or a node click while
    // inspecting. While they have it, a growing graph must never yank the view; while they do
    // NOT, the view must keep framing the whole picture — observed 2026-08-03: a heal sweep
    // grew and re-lit the graph under a zoomed camera until nodes overflowed the pane and
    // buried the legend, with only the manual reset control as the way back.
    const touch = (): void => { cameraTouched = true }
    container.addEventListener('wheel', touch, { capture: true, passive: true })
    container.addEventListener('pointerdown', touch, { capture: true })

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
          // reframe an untouched camera once the burst settles — the FlowFit contract, on sigma
          if (!cameraTouched) sigma.getCamera().animatedReset()
        }, SETTLE_MS)
      } else {
        // no Worker (jsdom, exotic embeds): one synchronous pass instead of a live simulation
        forceAtlas2.assign(g, { iterations: FALLBACK_ITERATIONS, settings: forceAtlas2.inferSettings(g) })
        if (!cameraTouched) sigma.getCamera().animatedReset()
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
          const color = edgeColorFor(heat, l.type)
          if (g.getEdgeAttribute(key, 'color') !== color)
            g.mergeEdgeAttributes(key, { color, size: EDGE_BASE_SIZE + heat * EDGE_HEAT_SIZE_SCALE })
        } else if (g.hasNode(l.source) && g.hasNode(l.target)) {
          g.addEdgeWithKey(key, l.source, l.target, {
            color: edgeColorFor(heat, l.type),
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
      container.removeEventListener('wheel', touch, { capture: true })
      container.removeEventListener('pointerdown', touch, { capture: true })
      sigmaRef = null
      sigma.kill()
    }
  }
</script>

{#if webglFailed}
  <div class="grid h-full w-full place-items-center text-xs text-mist">graph view needs WebGL, which this browser did not provide</div>
{:else}
  <div class="relative h-full w-full">
    <div class="h-full w-full" {@attach mount}></div>
    <!-- wheel-zoom and drag-pan have no other way back; one control restores the whole picture -->
    <button
      class="absolute top-2 right-2 z-10 grid size-6 cursor-pointer place-items-center rounded-(--radius-chip) border border-line bg-desk/90 text-mist hover:text-paper"
      title="reset the view to the whole graph"
      aria-label="reset graph view"
      onclick={() => {
        cameraTouched = false
        sigmaRef?.getCamera().animatedReset()
      }}
    >
      <ScanIcon class="size-3.5" />
    </button>
    <!-- the colour vocabulary, spelled from the same table the renderer paints with — five dots
         beat a hunt through colors.ts, and an unlabeled purple cloud reads as decoration -->
    <dl class="pointer-events-none absolute bottom-2 left-2 z-10 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-label text-fog select-none">
      {#each Object.entries(TYPE_COLORS) as [type, color] (type)}
        <div class="flex items-center gap-1">
          <dt><span class="block size-2 rounded-full" style:background={color} aria-hidden="true"></span></dt>
          <dd>{type}</dd>
        </div>
      {/each}
    </dl>
  </div>
{/if}
