// Hardcoded copies of app.css tokens (a WebGL canvas cannot read CSS properties), named per hex

// TYPE-ONLY imports: a node or edge kind added on the wire fails this file to compile
import type { EdgeType, NodeType } from '@orc/ui-core/graph-wire'

export type { NodeType }

export const TYPE_COLORS: Record<NodeType, string> = {
  // --color-machine family dimmed to rest; full brightness is reserved for the running override
  task: '#54808a',
  // lighter, grayer steel of the same family (machine mixed toward --color-mist)
  step: '#7d9dab',
  // amber-adjacent, softer than --color-human so an artifact never reads as a gate
  artifact: '#d9a66a',
  // WORKER hue, outside the two-temperature axis: a model is an actor, not a state
  model: '#bd82a8',
}

// Live overrides, strongest first: failed > blocked > running; settled states keep the type color
export const STATUS_COLORS: Record<string, string> = {
  failed: '#c4573b', // --color-rust
  blocked: '#c4573b', // --color-rust — same temperature as failed; StatusPill agrees
  running: '#6fa8b5', // --color-machine at full brightness (rest-state steel is dimmed above)
  cancelled: '#5c6472', // --color-fog
}

// only task/step carry a lifecycle in detail; an artifact's is its size, a model's its provider
export const colorFor = (type: NodeType, detail: string): string =>
  ((type === 'task' || type === 'step') ? STATUS_COLORS[detail] : undefined) ?? TYPE_COLORS[type]

export const isActive = (type: NodeType, detail: string): boolean =>
  (type === 'task' || type === 'step') && detail === 'running'

// shared chrome
export const EDGE_COLOR = '#2e3742' // --color-rule
export const LABEL_COLOR = '#e6e1d6' // --color-paper

// A `uses` edge is drawn in the worker hue, dimmed below the node; keyed by wire string
export const EDGE_BASE: Partial<Record<EdgeType, string>> = { uses: '#5c3f55' }

// Looked up by plain string: the wire parses `type` loosely, so unknown kinds fall back to chrome
const EDGE_BASE_BY_NAME = new Map<string, string>(Object.entries(EDGE_BASE))

export const edgeColorFor = (type: string): string => EDGE_BASE_BY_NAME.get(type) ?? EDGE_COLOR

/** the newest event's nodes flash in the human colour — attention, not status */
export const FLASH_COLOR = '#e8a33d' // --color-human

// Fade toward the page ground; parsed here because sigma's base renderer has no per-node alpha
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
