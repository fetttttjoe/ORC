// What a collapsed tool row says it did: the most identifying input field, probed, never trusted

// Most specific first: a preference order over what the shipped tools send, not a schema
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
  // Nothing recognised: name the KEYS, never dump values; an input may carry a whole file body
  const keys = Object.keys(obj)
  return keys.length === 0 ? '' : clip(keys.join(' '))
}
