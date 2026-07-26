import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MEMORY_LIMITS } from './limits'

// A claim's id IS its statement. A positional index would shift the moment a claim is invalidated —
// which the temporal model makes routine — so identity is content-derived: stable without counter
// state, self-deduplicating within a note, and giving a rewording the correct meaning (a new claim,
// with the old one invalidated rather than mutated).
const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ')

export const CLAIM_ID_LENGTH = 12
// One spelling of the id shape: the schema validates against it and the tool surface advertises it
// to writers, so the two cannot drift into a pattern that accepts what the parser rejects.
export const CLAIM_ID_RE = new RegExp(`^[a-f0-9]{${CLAIM_ID_LENGTH}}$`)

export const claimId = (text: string): string =>
  createHash('sha256').update(normalize(text)).digest('hex').slice(0, CLAIM_ID_LENGTH)

// What a writer supplies, and what the note payload stores. `validFrom` is absent BY DESIGN — the
// same rule MemorySourceInput follows for retrievedAt: the projector stamps it from the committed
// event, so an agent cannot date its own claim and there is no placeholder to leak.
export const ClaimInput = z.object({
  id: z.string().regex(CLAIM_ID_RE),
  text: z.string().min(1).max(MEMORY_LIMITS.detailChars),
  // nullish-in, null-out: an option column reads back as `undefined` and an older row has no such
  // key at all, so the schema normalizes both rather than every caller hand-mapping `?? null`.
  sourceRevision: z.string().nullish().default(null),
})
export type ClaimInput = z.infer<typeof ClaimInput>

// What the read model returns: the authored claim plus the event-derived date it first appeared.
export const Claim = ClaimInput.extend({ validFrom: z.string() })
export type Claim = z.infer<typeof Claim>

// The live set after one write. Invalidation wins over addition in the same write, so a caller that
// states both is asking for the claim to be gone.
export function resolveClaims(
  live: readonly ClaimInput[],
  addClaims: readonly string[],
  invalidates: readonly string[],
  sourceRevision: string | null,
): ClaimInput[] {
  const dead = new Set(invalidates)
  const out = new Map<string, ClaimInput>()
  for (const c of live) if (!dead.has(c.id)) out.set(c.id, c)
  for (const text of addClaims) {
    const id = claimId(text)
    if (dead.has(id)) continue
    // a surviving claim keeps its ORIGINAL revision: re-stating a fact does not re-ground it
    if (!out.has(id)) out.set(id, ClaimInput.parse({ id, text: normalize(text), sourceRevision }))
  }
  return [...out.values()].slice(0, MEMORY_LIMITS.detailItems)
}

// A matched statement, carrying enough of its owner to be actionable: the reader gets the claim it
// searched for AND the note to read for the surrounding fidelity. The title comes from the owning
// note rather than being duplicated onto every claim row.
export const ClaimHit = z.object({
  claimId: z.string(),
  noteId: z.string(),
  scope: z.string(),
  title: z.string(),
  text: z.string(),
  validFrom: z.string(),
})
export type ClaimHit = z.infer<typeof ClaimHit>

// How a writer changes a note's claims: name what to ADD and name what to RETIRE. `claims` itself is
// deliberately absent — supplying the array would REPLACE under the store's merge-on-omit rule,
// which is the behaviour additive writes exist to avoid. Both arrive on the write call and are
// parsed off it together; neither is a note field, so the note parse strips them.
export const ClaimWrite = z.object({
  addClaims: z.array(z.string().min(1).max(MEMORY_LIMITS.detailChars)).max(MEMORY_LIMITS.detailItems).default([]),
  invalidates: z.array(z.string().regex(CLAIM_ID_RE)).max(MEMORY_LIMITS.detailItems).default([]),
})
export type ClaimWrite = z.infer<typeof ClaimWrite>

// A claim's whole life, recovered by folding the log — the note payload carries live claims only, so
// this is the ONLY way to see one that was retired and the write that retired it. `validFrom` here
// is the ts of the event that FIRST carried the claim (the same rule the projector stamps by), and
// `invalidatedAt` the ts of the write that named it in `invalidates`.
export interface ClaimHistoryEntry {
  id: string
  text: string
  sourceRevision: string | null
  validFrom: string
  invalidatedAt: string | null
}

// Folded in event order, so `events` MUST be ordered by seq. A claim re-added after being retired is
// live again with its invalidatedAt cleared — the log says it came back, and pretending otherwise
// would report a fact as dead while search returns it.
export function claimHistory(
  events: ReadonlyArray<{ ts?: string | null; claims: readonly ClaimInput[]; invalidates: readonly string[] }>,
): ClaimHistoryEntry[] {
  const seen = new Map<string, ClaimHistoryEntry>()
  for (const e of events) {
    const ts = e.ts ?? ''
    for (const c of e.claims) {
      const prev = seen.get(c.id)
      // first sighting fixes validFrom; a survivor keeps it, and a revived claim loses its tombstone
      if (prev) seen.set(c.id, { ...prev, text: c.text, sourceRevision: c.sourceRevision, invalidatedAt: null })
      else seen.set(c.id, { id: c.id, text: c.text, sourceRevision: c.sourceRevision, validFrom: ts, invalidatedAt: null })
    }
    for (const id of e.invalidates) {
      const prev = seen.get(id)
      // a tombstone for a claim this log never carried is ignored, exactly as resolveClaims ignores it
      if (prev) seen.set(id, { ...prev, invalidatedAt: ts })
    }
  }
  return [...seen.values()]
}
