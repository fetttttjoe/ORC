<script lang="ts">
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'
  import ConsoleHeader from '$lib/components/ConsoleHeader.svelte'
  import CopilotChat from '$lib/features/copilot/CopilotChat.svelte'
  import GraphIsland from '$lib/features/graph/GraphIsland.svelte'
  import Inspector from '$lib/features/inspector/Inspector.svelte'
  import Ledger from '$lib/features/ledger/Ledger.svelte'
  import NewRequestForm from '$lib/features/forms/NewRequestForm.svelte'
  import AppSidebar from '$lib/features/sidebar/AppSidebar.svelte'
  import * as SidebarUi from '$lib/components/ui/sidebar'
  import { api, setApiErrorHandler, setAuth } from '$lib/api/client'
  import { allViewsKey, fetchView } from '$lib/api/view-client'
  import { VIEW } from '@orc/ui-core/wire'
  import { ScopeType } from '@orc/contracts/scope'
  import { Toaster } from '$lib/components/ui/sonner'
  import { notify } from '$lib/notify'
  import OverviewStrip from '$lib/features/overview/OverviewStrip.svelte'
  import SystemBanner from '$lib/features/overview/SystemBanner.svelte'
  import { connectStream, type StreamHandle } from '$lib/sse'
  import { graph } from '$lib/stores/graph.svelte'
  import { ledger } from '$lib/stores/ledger.svelte'
  import { operator } from '$lib/stores/operator.svelte'
  import { session } from '$lib/stores/session.svelte'

  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
  })

  setApiErrorHandler(err => notify(`${err.endpoint}: ${err.message}`, 'error'))

  let stream: StreamHandle | null = null
  // not $state: a write guard read only inside the effect that sets it
  let loadedProject = ''

  const SNAPSHOT_RETRY_MS = 1_500

  async function loadProject(project: string): Promise<void> {
    stream?.close()
    // A server still coming up answers with an error; retry or the page stays empty
    let snap
    try {
      snap = await api.graph(project)
    } catch {
      session.live = false
      await new Promise(resolve => setTimeout(resolve, SNAPSHOT_RETRY_MS))
      snap = await api.graph(project)
    }
    graph.setSnapshot(snap)
    // A fresh snapshot outdates every held view; a resync ships no touched entries
    void queryClient.invalidateQueries({ queryKey: allViewsKey() })
    // seed to the snapshot seq, attach the stream there: its catch-up frame closes any gap
    const { data: rows } = await fetchView(project, VIEW.timeline, { scope: { type: ScopeType.project }, limit: 150 })
    ledger.reset(0)
    operator.reset()
    for (const row of rows ?? []) if (row.seq <= snap.seq) ledger.add(row)
    stream = connectStream({
      project,
      fromSeq: snap.seq,
      queryClient,
      onProjects: p => (session.projects = p),
      onLive: live => (session.live = live),
      onSeqRegression: () => void loadProject(project),
    })
  }

  const boot = (async () => {
    const [info, projects] = await Promise.all([api.session(), api.projects()])
    session.init(info, projects)
    setAuth(info.token ?? '', session.sel.project)
    // claim the project BEFORE awaiting, so the switch effect below does not re-load it
    loadedProject = session.sel.project
    if (session.sel.project) await loadProject(session.sel.project)
  })()

  // Pixel width clamped against the current viewport on every resize, so the ledger is not crushed
  const DOCK_MIN = 280
  const MAIN_MIN = 420 // the narrowest ledger that still reads without truncating its chips
  const SIDEBAR_W = 288 // w-72, the sidebar's fixed track
  const DOCK_KEY = 'orc:dockWidth'

  // DOCK_MIN wins when the viewport cannot hold both the dock and MAIN_MIN
  const clampDock = (w: number): number =>
    Math.max(DOCK_MIN, Math.min(w, Math.max(DOCK_MIN, window.innerWidth - SIDEBAR_W - MAIN_MIN)))

  // a browser that refuses storage (private mode) must not take the console down with it
  const readStored = (): number | null => {
    try {
      const raw = Number(localStorage.getItem(DOCK_KEY))
      return Number.isFinite(raw) && raw > 0 ? raw : null
    } catch {
      return null
    }
  }
  const writeStored = (w: number): void => {
    try {
      localStorage.setItem(DOCK_KEY, String(w))
    } catch {
      /* the dock still works this session; it is just not remembered */
    }
  }

  let dockWidth = $state(clampDock(readStored() ?? Math.round(window.innerWidth * 0.38)))

  // Registered once: dockWidth is read in the closure, so drags do not re-subscribe
  $effect(() => {
    const onResize = (): void => {
      dockWidth = clampDock(dockWidth)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  function startResize(e: PointerEvent): void {
    const startX = e.clientX
    const startW = dockWidth
    const move = (ev: PointerEvent): void => {
      dockWidth = clampDock(startW + (startX - ev.clientX))
    }
    const up = (): void => {
      writeStored(dockWidth) // on release, not per frame — a drag is ~60 writes a second otherwise
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  $effect(() => {
    const p = session.sel.project
    if (p && p !== loadedProject) {
      loadedProject = p
      void boot.then(() => {
        setAuth(session.info.token ?? '', p)
        return loadProject(p)
      })
    }
  })
</script>

<QueryClientProvider client={queryClient}>
  <div class="flex h-full flex-col">
    <ConsoleHeader />
    <div class="flex min-h-0 grow">
      <SidebarUi.Provider class="min-h-0 w-72 shrink-0" style="--sidebar-width: 18rem">
        <AppSidebar>
          {#snippet children({ close })}
            <NewRequestForm onsubmitted={close} />
          {/snippet}
        </AppSidebar>
      </SidebarUi.Provider>
      <main class="flex min-w-0 grow flex-col overflow-hidden border-r border-line">
        <SystemBanner />
        <OverviewStrip />
        <Ledger />
        <CopilotChat />
      </main>
      <div class="relative hidden shrink-0 overflow-hidden lg:block" style:width={dockWidth + 'px'}>
        <button class="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize bg-transparent hover:bg-machine/40" aria-label="resize graph panel" onpointerdown={startResize}></button>
        <GraphIsland />
      </div>
      {#if session.sel.node}
        <Inspector />
      {/if}
    </div>
  </div>
</QueryClientProvider>

<Toaster position="bottom-right" theme="dark" richColors closeButton />
