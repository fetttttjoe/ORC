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
  import { Toaster } from '$lib/components/ui/sonner'
  import { notify } from '$lib/notify'
  import OverviewStrip from '$lib/features/overview/OverviewStrip.svelte'
  import SystemBanner from '$lib/features/overview/SystemBanner.svelte'
  import { connectStream, type StreamHandle } from '$lib/sse'
  import { graph } from '$lib/stores/graph.svelte'
  import { ledger } from '$lib/stores/ledger.svelte'
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
    // A server still coming up answers /api/graph with an error; without a retry the page stays
    // permanently empty with no path back short of a manual reload.
    let snap
    try {
      snap = await api.graph(project)
    } catch {
      session.live = false
      await new Promise(resolve => setTimeout(resolve, SNAPSHOT_RETRY_MS))
      snap = await api.graph(project)
    }
    graph.setSnapshot(snap)
    // seed to the snapshot seq, attach the stream there: its catch-up frame closes any gap
    const rows = await api.log(project, { limit: 150 })
    ledger.reset(0)
    for (const row of rows) if (row.seq <= snap.seq) ledger.add(row)
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

  let dockWidth = $state(Math.round(window.innerWidth * 0.38))
  function startResize(e: PointerEvent): void {
    const startX = e.clientX
    const startW = dockWidth
    const move = (ev: PointerEvent): void => {
      dockWidth = Math.min(window.innerWidth * 0.7, Math.max(280, startW + (startX - ev.clientX)))
    }
    const up = (): void => {
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
