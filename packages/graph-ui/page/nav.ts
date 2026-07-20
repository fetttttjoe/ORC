// The ONE navigation model: selection lives in the URL hash (#p=…&n=…&tab=…), navigate()
// merges a partial change, and onChange is the only place selection gets rendered from.
// Every link everywhere calls navigate — deep links, refresh, and back/forward come free.
export type Tab = 'request' | 'detail' | 'chat' | 'log'
export type View = 'chat' | 'split' | 'graph'
export interface Selection { project: string; node: string | null; tab: Tab; view: View }

const TABS: readonly Tab[] = ['request', 'detail', 'chat', 'log']
const VIEWS: readonly View[] = ['chat', 'split', 'graph']

export function current(): Selection {
  const h = new URLSearchParams(location.hash.slice(1))
  const tab = h.get('tab') as Tab | null
  const view = h.get('view') as View | null
  return {
    project: h.get('p') ?? '',
    node: h.get('n'),
    tab: tab && TABS.includes(tab) ? tab : 'detail',
    view: view && VIEWS.includes(view) ? view : 'split',
  }
}

export function navigate(patch: Partial<Selection>): void {
  const next = { ...current(), ...patch }
  const h = new URLSearchParams()
  if (next.project) h.set('p', next.project)
  if (next.node) h.set('n', next.node)
  if (next.tab !== 'detail') h.set('tab', next.tab)
  if (next.view !== 'split') h.set('view', next.view)
  location.hash = h.toString()
}

export function onChange(cb: (s: Selection) => void): void {
  window.addEventListener('hashchange', () => cb(current()))
  cb(current())
}
