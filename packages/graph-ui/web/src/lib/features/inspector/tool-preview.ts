// What a COLLAPSED tool row says it did. A transcript row shows the tool name and its iteration,
// which for a run that calls fs_read sixty times renders sixty identical-looking rows: the operator
// must expand each one to find the call they want. This picks the single most identifying field
// from an arbitrary tool input so the row is scannable shut.
//
// Pure and zero-import: the shape is agent-authored JSON, so it is probed, never trusted.

/**
 * The fields that identify a call, most-specific first. Tool inputs are open shapes (each tool
 * defines its own), so this is a preference order over what the shipped tools actually send —
 * `path` for fs_*, `command` for exec, `query`/`id`/`seed` for the memory tools — not a schema.
 */
const IDENTIFYING_KEYS = ['path', 'command', 'query', 'id', 'seed', 'taskId', 'title'] as const

/** Past this the preview stops earning its line — the row is a summary, not the payload. */
const MAX_CHARS = 72

const clip = (s: string): string => (s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS - 1)}…`)

export function toolPreview(input: unknown): string {
  if (typeof input === 'string') return clip(input)
  if (input === null || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of IDENTIFYING_KEYS) {
    const v = obj[key]
    // a number is identifying too (a seq, a limit); an object under these keys is not
    if (typeof v === 'string' && v !== '') return clip(v)
    if (typeof v === 'number') return clip(String(v))
  }
  // Nothing recognised: name the KEYS rather than dump values. A tool this file has never seen
  // still gets a row that says how the call differs from its neighbours, and an input carrying a
  // whole file body never lands a kilobyte of prose in a one-line summary.
  const keys = Object.keys(obj)
  return keys.length === 0 ? '' : clip(keys.join(' '))
}
