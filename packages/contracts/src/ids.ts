export const MEMORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/

// The one spelling of a sha256-hex digest. It was spelled inline at three sites (artifact
// receipts, plan hashes, kernel trust fingerprints) — a widened or typo'd copy would admit
// digests the other two reject.
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/

// Trim one repeated character off both ends by index. The regex this replaces (`/^-+|-+$/`) was
// linear ONLY because the collapse below guarantees no repeated dashes — an invariant neither a
// reader nor a scanner can see, and one an innocent edit could turn into quadratic backtracking on
// a hostile title. Indexing carries no such footgun.
export function trimEdges(value: string, ch: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === ch) start++
  while (end > start && value[end - 1] === ch) end--
  return value.slice(start, end)
}

// Deterministic MEMORY_ID_RE-safe id from a human title.
export function slugId(title: string): string {
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') // one pass, no backtracking
  const s = trimEdges(trimEdges(collapsed, '-').slice(0, 64), '-')
  if (!MEMORY_ID_RE.test(s))
    throw new Error(`cannot derive an id from '${title}' — use latin letters or digits`)
  return s
}
