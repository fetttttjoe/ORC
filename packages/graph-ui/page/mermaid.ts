// Mermaid rendering — strict security level, dark theme, SVG inserted via DOMParser (never
// innerHTML). All diagram text is generated server-side from typed data through mermaidLabel.
// Loaded lazily: mermaid is ~3MB of the bundle and only needed once a diagram appears.
let loading: Promise<typeof import('mermaid').default> | null = null
let counter = 0

function ensureInit(): Promise<typeof import('mermaid').default> {
  loading ??= import('mermaid').then(m => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      themeVariables: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px' },
    })
    return m.default
  })
  return loading
}

export async function mermaidInto(container: HTMLElement, text: string): Promise<void> {
  try {
    const mermaid = await ensureInit()
    const { svg } = await mermaid.render(`mmd-${++counter}`, text)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    if (root.tagName.toLowerCase() === 'svg') {
      root.removeAttribute('height') // let CSS size it
      container.replaceChildren(document.adoptNode(root))
    }
  } catch {
    container.replaceChildren(document.createTextNode('diagram unavailable'))
  }
}
