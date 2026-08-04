// session + navigation; the URL hash is the source of truth for selection
import type { ProjectEntry, SessionInfo } from '$lib/api/types'

export type Tab = 'request' | 'detail' | 'chat' | 'log'

export interface Selection {
  project: string
  node: string | null
  tab: Tab
}

const parseHash = (): Partial<Selection> => {
  const p = new URLSearchParams(location.hash.slice(1))
  const tab = p.get('tab')
  const project = p.get('p')
  return {
    ...(project !== null && project !== '' ? { project } : {}),
    node: p.get('n'),
    tab: tab === 'request' || tab === 'detail' || tab === 'chat' || tab === 'log' ? tab : 'detail',
  }
}

class SessionStore {
  info = $state.raw<SessionInfo>({ projectId: null, actions: false, copilot: false })
  projects = $state.raw<ProjectEntry[]>([])
  sel = $state<Selection>({ project: '', node: null, tab: 'detail' })
  live = $state(false)
  /** dim everything outside the selected request's subtree in the graph */
  focus = $state(false)
  /** how many selections this page has made — the back button has nowhere to go at 1 */
  visited = $state(0)

  init(info: SessionInfo, projects: ProjectEntry[]): void {
    this.info = info
    this.projects = projects
    const h = parseHash()
    this.sel = {
      project: h.project ?? info.projectId ?? projects[0]?.id ?? '',
      node: h.node ?? null,
      tab: h.tab ?? 'detail',
    }
    if (this.sel.node !== null) this.visited = 1
    window.addEventListener('hashchange', () => {
      const n = parseHash()
      const next = { project: n.project ?? this.sel.project, node: n.node ?? null, tab: n.tab ?? 'detail' }
      if (next.node !== null && next.node !== this.sel.node) this.visited += 1
      this.sel = next
    })
  }

  navigate(next: Partial<Selection>): void {
    const s = { ...this.sel, ...next }
    const p = new URLSearchParams()
    if (s.project) p.set('p', s.project)
    if (s.node) p.set('n', s.node)
    if (s.node) p.set('tab', s.tab)
    location.hash = p.toString()
  }

  /**
   * EXECUTING (run/approve/retry/propose/edit) needs the runtime that lives in the project this
   * server was started in — from a foreign chat it would be a silent cross-project write, and the
   * server refuses it.
   */
  canAct(): boolean {
    return this.info.actions && this.sel.project === this.info.projectId
  }

  /**
   * ANSWERING is a pure append to whichever project asked, so it is allowed from any chat this
   * server can write at all. Kept separate from canAct deliberately: fencing replies to the home
   * project shows the operator a live question and then refuses to let them answer it.
   */
  canAnswer(): boolean {
    return this.info.actions
  }
}

export const session = new SessionStore()

