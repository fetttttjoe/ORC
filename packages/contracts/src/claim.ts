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

// How a writer changes a note's claims: name what to ADD and name what to RETIRE. `claims` itself is
// deliberately absent — supplying the array would REPLACE under the store's merge-on-omit rule,
// which is the behaviour additive writes exist to avoid. Both arrive on the write call and are
// parsed off it together; neither is a note field, so the note parse strips them.
export const ClaimWrite = z.object({
  addClaims: z.array(z.string().min(1).max(MEMORY_LIMITS.detailChars)).max(MEMORY_LIMITS.detailItems).default([]),
  invalidates: z.array(z.string().regex(CLAIM_ID_RE)).max(MEMORY_LIMITS.detailItems).default([]),
})
export type ClaimWrite = z.infer<typeof ClaimWrite>

// The key a note written before claims existed carried its statements in. Named, not spelled out at
// each use, for the same reason LEGACY_PLAN_KIND is: the decoder below and every test that pins it
// have to mean the same field, and the log is immutable so this name can never be corrected.
export const LEGACY_CLAIMS_FIELD = 'rules'

// Legacy `rules[]` predates every bound ClaimInput now enforces (text length, non-empty). This runs
// inside a z.preprocess (memory.ts's withClaims), where a thrown error is a plain function-call
// exception, not a collected parse issue — it passes straight through `safeParse` uncaught. That is
// the exact wedge surreal.ts's projector comment documents for memory_written: one unparseable
// legacy payload must cost its own note revision, never abort the whole replay. So history is
// reshaped to fit rather than validated and rejected: clamp an overlong rule, drop a blank one.
export const claimsFromLegacyRules = (rules: readonly string[], sourceRevision: string | null): ClaimInput[] =>
  resolveClaims(
    [],
    rules.map(r => normalize(r).slice(0, MEMORY_LIMITS.detailChars)).filter(r => r.length > 0),
    [],
    sourceRevision,
  )
