// The ONE color vocabulary for every projection of the graph — WebGL nodes, mermaid diagrams,
// and any future TUI derive from these named tokens, never from scattered hex literals
// (same convention as EDGE_DIRECTION: a const map, not strings sprinkled through the code).
export const PALETTE = {
  // node types at rest
  task: '#7aa2f7', step: '#9ece6a', artifact: '#e0af68', note: '#bb9af7', model: '#89dceb',
  // live lifecycle states (running distinct from the artifact amber so they never read alike)
  running: '#ff9e64', danger: '#f7768e', cancelled: '#565f89',
  // shared chrome
  edge: '#3b3b47', text: '#e4e4e9', textDim: '#8b8b96', surface: '#22222c',
  // mermaid card fills
  doneFill: '#1f5c31', runningFill: '#5c4a1f', failedFill: '#5c1f2a',
} as const
