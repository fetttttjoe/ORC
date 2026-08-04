// The health vocabulary every surface reports through — CLI status line, /api/health, the MCP
// door's project_status, and the browser header. Zero imports so the browser bundle can take it
// without pulling the memory domain (and node:crypto with it).

export const MEMORY_HEALTH = { ok: 'ok', catchingUp: 'catching_up', unreachable: 'unreachable' } as const
export type MemoryHealthState = (typeof MEMORY_HEALTH)[keyof typeof MEMORY_HEALTH]

export interface MemoryHealth {
  state: MemoryHealthState
  pending: number // knowledge events not yet applied to the read model
  reason?: string
  // How far the graph has fallen behind the working tree. `pending` measures the read model
  // catching up with the LOG — a lag orc creates and fixes by itself. This measures the corpus
  // catching up with the CODE, which orc cannot fix by itself: when the repo moves without going
  // through orc (another editor, a merge, a refactor landed elsewhere) nothing retires the claims
  // that describe what used to be there. Absent when it could not be measured (no repo, no
  // checkable notes) — never a fabricated zero, which would read as "healthy".
  drift?: { checkable: number; drifted: number; ratio: number }
}

// Whether anything can DRIVE a run right now — the question every silent project raises first.
// Derived from the supervisor heartbeat row plus the pid file the serve process writes only once
// its runtime is ready: heartbeat+pidfile = ready, heartbeat alone = booting, a stale row = it
// died without cleanup, no row = nothing will run until `orc serve`.
export const SUPERVISOR_HEALTH = { ready: 'ready', booting: 'booting', stale: 'stale', none: 'none' } as const
export type SupervisorHealthState = (typeof SUPERVISOR_HEALTH)[keyof typeof SUPERVISOR_HEALTH]
export interface SupervisorHealth {
  state: SupervisorHealthState
  pid?: number
  lastSeenAt?: string
}
