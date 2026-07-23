// Tiny DOM builder — every component is a function returning an HTMLElement built from
// createElement/textContent (never innerHTML: much of what we render is agent-written).
export type Child = Node | string | null | undefined | false

// the closed set of data-* keys the pages use — extend the union when a new lookup is needed
export type DataKey = 'step' | 'note'

export interface Attrs {
  class?: string
  title?: string
  onClick?: (ev: MouseEvent) => void
  data?: Partial<Record<DataKey, string>> // dataset entries — { step: id } → data-step, for event→element lookups
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs.class) node.className = attrs.class
  if (attrs.title) node.title = attrs.title
  if (attrs.onClick) node.addEventListener('click', attrs.onClick as EventListener)
  for (const [k, v] of Object.entries(attrs.data ?? {})) node.dataset[k] = v
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}
