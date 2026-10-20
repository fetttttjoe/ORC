export const SLUG_ID_RE = /^[a-z0-9][a-z0-9-]*$/

// the one spelling of a sha256-hex digest, shared by receipts, plan hashes and fingerprints
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/

// trims by index: a regex is linear only while the collapse guarantees no repeated dashes
export function trimEdges(value: string, ch: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === ch) start++
  while (end > start && value[end - 1] === ch) end--
  return value.slice(start, end)
}

// Deterministic SLUG_ID_RE-safe id from a human title.
export function slugId(title: string): string {
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') // one pass, no backtracking
  const s = trimEdges(trimEdges(collapsed, '-').slice(0, 64), '-')
  if (!SLUG_ID_RE.test(s))
    throw new Error(`cannot derive an id from '${title}' — use latin letters or digits`)
  return s
}
