// Node/edge color vocabulary for the sigma island — pure, zero-import, pinned by colors.test.ts.
// A WebGL canvas cannot read CSS custom properties, so these are hardcoded copies of the app.css
// @theme tokens with the token named beside each hex — change a token there, grep the name here.
// Status strings mirror the TASK_STATUS/STEP_RUN_STATUS wire values; the test pins the set.

export type NodeType = 'task' | 'step' | 'artifact' | 'note' | 'model'

export const TYPE_COLORS: Record<NodeType, string> = {
  // --color-machine (#6fa8b5) family, dimmed to rest — full brightness is reserved for the
  // running override, otherwise a running task would be indistinguishable from an idle one
  task: '#54808a',
  // lighter, grayer steel of the same family (machine mixed toward --color-mist)
  step: '#7d9dab',
  // amber-adjacent, deliberately softer than --color-human (#e8a33d) so an artifact never
  // reads as a gate awaiting the operator
  artifact: '#d9a66a',
  // violet — outside the two-temperature axis entirely; notes carry no lifecycle
  note: '#9e8cfb',
  model: '#8b93a1', // --color-mist
}

// Live lifecycle overrides, strongest first: failed > blocked > running. Settled states
// (done/completed/pending) keep the type color — the graph shows what is HAPPENING, not history.
export const STATUS_COLORS: Record<string, string> = {
  failed: '#c4573b', // --color-rust
  blocked: '#c4573b', // --color-rust — same temperature as failed; StatusPill agrees
  running: '#6fa8b5', // --color-machine at full brightness (rest-state steel is dimmed above)
  cancelled: '#5c6472', // --color-fog
}

// only task/step carry a lifecycle in `detail`; a note's detail is its kind, an artifact's its
// size — recoloring those on a coincidental string was the bug the legacy test pinned against
export const colorFor = (type: NodeType, detail: string): string =>
  ((type === 'task' || type === 'step') ? STATUS_COLORS[detail] : undefined) ?? TYPE_COLORS[type]

export const isActive = (type: NodeType, detail: string): boolean =>
  (type === 'task' || type === 'step') && detail === 'running'

// shared chrome
export const EDGE_COLOR = '#2e3742' // --color-rule
export const LABEL_COLOR = '#e6e1d6' // --color-paper

// brightness from heat: lerp the dim base edge toward paper — a walked connection reads as lit,
// an untouched one stays in the chrome background. heat 0 renders the same color as EDGE_COLOR
// (as an rgb() triplet, which canvas treats identically to the hex literal).
export const edgeColorFor = (heat: number): string => {
  const h = Math.min(Math.max(heat, 0), 1)
  const e = parseInt(EDGE_COLOR.slice(1), 16)
  const p = parseInt(LABEL_COLOR.slice(1), 16)
  const mix = (shift: number): number => {
    const c = (e >> shift) & 0xff
    return Math.round(c + (((p >> shift) & 0xff) - c) * h)
  }
  return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`
}

/** the newest event's nodes flash in the human colour — attention, not status */
export const FLASH_COLOR = '#e8a33d' // --color-human

/**
 * Fade a colour toward the page ground for focus dimming. Parsing here (not a CSS opacity) because
 * sigma paints into WebGL, where a per-node alpha is not available on the base renderer.
 */
export function dim(hex: string, amount = 0.78): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m?.[1]) return hex
  const n = Number.parseInt(m[1], 16)
  const mix = (c: number, ground: number): number => Math.round(c + (ground - c) * amount)
  const r = mix((n >> 16) & 255, 0x0e)
  const g = mix((n >> 8) & 255, 0x11)
  const b = mix(n & 255, 0x16)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
