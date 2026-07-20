// Mermaid rendering — strict security level, dark theme, SVG inserted via DOMParser (never
// innerHTML). All diagram text is generated server-side from typed data through mermaidLabel.
import mermaid from 'mermaid'

let initialized = false
let counter = 0

function ensureInit(): void {
  if (initialized) return
  initialized = true
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    themeVariables: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px' },
  })
}

export async function mermaidInto(container: HTMLElement, text: string): Promise<void> {
  ensureInit()
  try {
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
