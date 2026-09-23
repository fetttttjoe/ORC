import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { MemoryAuthor } from './author'
import { normalizeEntity, pathSegments, ROOT_ENTITY } from './entity-of'
import { MEMORY_ID_RE } from './ids'
import { MEMORY_LIMITS } from './limits'
import { ProvisionalFlag } from './workspace-entity'

// A claim's id IS its statement. A positional index would shift the moment a claim is invalidated —
// which the temporal model makes routine — so identity is content-derived: stable without counter
// state, self-deduplicating within a note, and giving a rewording the correct meaning (a new claim,
// with the old one invalidated rather than mutated).
// NFC first: the same sentence typed with a precomposed 'é' and with 'e' + U+0301 is ONE statement,
// and without this it hashes to two claim ids — so `invalidates` would retire only the spelling the
// writer happened to send. ASCII is unaffected (NFC is the identity there), so no existing id moves.
const normalize = (text: string): string => text.normalize('NFC').trim().replace(/\s+/g, ' ')

export const CLAIM_ID_LENGTH = 12
// One spelling of the id shape: the schema validates against it and the tool surface advertises it
// to writers, so the two cannot drift into a pattern that accepts what the parser rejects.
export const CLAIM_ID_RE = new RegExp(`^[a-f0-9]{${CLAIM_ID_LENGTH}}$`)

export const claimId = (text: string): string =>
  createHash('sha256').update(normalize(text)).digest('hex').slice(0, CLAIM_ID_LENGTH)

// Blank-after-normalization is not a statement. Checked HERE, on the string the writer actually
// sent: `"   "` used to pass `min(1)` on the raw text, get normalized to `''` inside resolveClaims,
// and fail ClaimInput's own min(1) deep in the log transaction — so the writer was handed a
// ZodError about `claims.0.text`, a field it never supplied and cannot find in the tool schema.
const ClaimText = z.string().min(1).max(MEMORY_LIMITS.detailChars)
  .refine(text => normalize(text) !== '', 'a claim cannot be blank')

export enum ClaimClass {
  fact = 'fact',
  why = 'why',
}

export const EntityPath = z.string().min(1)
  .refine(path => !path.includes('\0'), 'a path cannot contain NUL')
  .refine(path => !/^(?:[/\\]|[A-Za-z]:)/.test(path), 'a path must be relative')
  .refine(path => !pathSegments(path).includes('..'), 'a path cannot contain ..')
  .transform(normalizeEntity)
export type EntityPath = z.infer<typeof EntityPath>

const ClaimAnchorPath = EntityPath.refine(path => path !== ROOT_ENTITY, 'an anchor path cannot be the root')

export const ClaimAnchorInput = z.object({
  path: ClaimAnchorPath,
  symbol: z.string().min(1).nullish().default(null),
})
export type ClaimAnchorInput = z.infer<typeof ClaimAnchorInput>

export const ClaimAnchor = ClaimAnchorInput.extend({ blob: z.string().nullish().default(null) })
export type ClaimAnchor = z.infer<typeof ClaimAnchor>

// declared, not inferred: inferring it inside VerifiedStamp exceeds TS instantiation depth and silently drops the field
export interface VerifiedClaim {
  claimId: string
  anchors: ClaimAnchor[]
}
export const VerifiedClaim: z.ZodType<VerifiedClaim> = z.object({
  claimId: z.string().regex(CLAIM_ID_RE),
  anchors: z.array(ClaimAnchor).max(MEMORY_LIMITS.claimAnchors),
})

export const ClaimDraft = z.object({
  text: ClaimText,
  class: z.enum(ClaimClass),
  anchors: z.array(ClaimAnchorInput).max(MEMORY_LIMITS.claimAnchors).default([]),
})
export type ClaimDraft = z.infer<typeof ClaimDraft>

// What a writer supplies, and what the note payload stores. `validFrom` is absent BY DESIGN — the
// same rule MemorySourceInput follows for retrievedAt: the projector stamps it from the committed
// event, so an agent cannot date its own claim and there is no placeholder to leak.
export const ClaimInput = z.object({
  id: z.string().regex(CLAIM_ID_RE),
  text: z.string().min(1).max(MEMORY_LIMITS.detailChars),
  class: z.enum(ClaimClass),
  anchors: z.array(ClaimAnchor).max(MEMORY_LIMITS.claimAnchors),
  // nullish-in, null-out: an option column reads back as `undefined` and an older row has no such
  // key at all, so the schema normalizes both rather than every caller hand-mapping `?? null`.
  sourceRevision: z.string().nullish().default(null),
})
export type ClaimInput = z.infer<typeof ClaimInput>

// What the read model returns: the authored claim plus the event-derived date it first appeared.
export const Claim = ClaimInput.extend({ validFrom: z.string() })
export type Claim = z.infer<typeof Claim>

// a draft whose anchors already carry their blobs — the only shape resolveClaims accepts
export interface StampedAddition {
  text: string
  class: ClaimClass
  anchors: ClaimAnchor[]
}

// The live set after one write. Invalidation wins over addition in the same write, so a caller that
// states both is asking for the claim to be gone.
export function resolveClaims(
  live: readonly ClaimInput[],
  additions: readonly StampedAddition[],
  invalidates: readonly string[],
  sourceRevision: string | null,
): ClaimInput[] {
  const dead = new Set(invalidates)
  const out = new Map<string, ClaimInput>()
  for (const c of live) if (!dead.has(c.id)) out.set(c.id, c)
  for (const addition of additions) {
    const id = claimId(addition.text)
    if (dead.has(id)) continue
    // a surviving claim keeps its ORIGINAL revision, class and anchors: re-stating a fact does not re-ground it
    if (!out.has(id))
      out.set(id, ClaimInput.parse({
        id, text: normalize(addition.text), class: addition.class, anchors: addition.anchors, sourceRevision,
      }))
  }
  // At the cap the write FAILS, loudly. This used to `.slice(0, detailItems)`, and because insertion
  // order is live-first-additions-last the slice always dropped exactly the NEW claims — the event
  // was appended with the unchanged set and memory_write still returned success, so a writer was
  // told its statement was recorded when it was not. Evicting an older claim instead would retire a
  // fact nobody asked to retire, so the choice belongs to the writer: the message names it.
  if (out.size > MEMORY_LIMITS.detailItems)
    throw new Error(
      `too many claims: ${out.size} exceeds the ${MEMORY_LIMITS.detailItems}-claim limit for one note`
      + ` — invalidate the claims this write supersedes, or split the note`,
    )
  return [...out.values()]
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
  class: z.enum(ClaimClass),
  anchors: z.array(ClaimAnchor),
  validFrom: z.string(),
  // The owner's two drift inputs, carried so a claim can be dated like a note can. Without them the
  // preload's currency verdict was computed from the NOTES arm alone — and claims take the budget
  // FIRST, so at the default budget a block is typically several claims and one note: most of what
  // the step was handed sat under a confidence the checker never examined. Sourced from the owning
  // note (a claim has its own sourceRevision but declares no paths, so the note is the unit that can
  // be checked against the tree), which joinClaimOwners already has in hand.
  sourceRevision: z.string().nullable(),
  paths: z.array(z.string()),
  // The owner's workspace and the flag derived from it, carried for exactly the reason the drift
  // inputs above are: claims take the search budget FIRST, so at a default budget most of what a
  // reader is handed is claims — flagging only the notes arm would leave the majority of the reply
  // reading as trunk knowledge while it is still pending in a worktree.
  workspaceId: z.string(),
  provisional: ProvisionalFlag.optional(),
})
export type ClaimHit = z.infer<typeof ClaimHit>

// Options that belong to CLAIM retrieval specifically, which is why they are not on
// MemorySearchOpts: the note search honours neither, and advertising them there would promise
// behaviour it ignores.
//   `limit` caps NOTES under the default perNote, and CLAIMS under 'all'.
//   `perNote` picks the question. 'best' is retrieval — one note must not fill every slot. 'all' is
//   enumeration ("which claims cite this path"), where the answer is a set and collapsing it to one
//   per note silently withholds the siblings.
export interface ClaimSearchOptions { limit?: number; perNote?: 'best' | 'all' }

// How a writer changes a note's claims: name what to ADD and name what to RETIRE. `claims` itself is
// deliberately absent — supplying the array would REPLACE under the store's merge-on-omit rule,
// which is the behaviour additive writes exist to avoid. Both arrive on the write call and are
// parsed off it together; neither is a note field, so the note parse strips them.
export const ClaimWrite = z.object({
  addClaims: z.array(ClaimDraft).max(MEMORY_LIMITS.detailItems).default([]),
  invalidates: z.array(z.string().regex(CLAIM_ID_RE)).max(MEMORY_LIMITS.detailItems).default([]),
  // stated about THIS write, never carried forward from an earlier one
  why: z.string().min(1).max(MEMORY_LIMITS.detailChars).nullish().default(null),
  decision: z.string().regex(MEMORY_ID_RE).nullish().default(null),
})
export type ClaimWrite = z.infer<typeof ClaimWrite>

// the write act at either end of a validity stretch; why/decision belong to that act alone
export interface ClaimAct {
  seq: number
  ts: string
  sourceRevision: string | null
  why: string | null
  decision: string | null
  author: MemoryAuthor
}

// one validity stretch; a claim retired and re-added has one interval each
export interface ClaimInterval {
  id: string
  text: string
  class: ClaimClass
  anchors: ClaimAnchor[]
  sourceRevision: string | null
  validFrom: string
  invalidatedAt: string | null
  addedBy: ClaimAct
  retiredBy: ClaimAct | null
}

// ONE note's write/delete events in seq order — claim identity is (scope, noteId, claimId)
export interface ClaimEvent {
  seq: number
  ts: string
  author: MemoryAuthor
  sourceRevision: string | null
  why: string | null
  decision: string | null
  claims: readonly ClaimInput[]
  invalidates: readonly string[]
  deleted: boolean
}

// The fold's input is LOGGED retirements, not every way a claim can leave the live set. Two events
// end a stretch: a write naming the claim in `invalidates`, and a `memory_deleted` for its note
// (`deleted`) — the projector drops that note's claim rows with it, so reporting them live would
// contradict search on a claim that no read model holds. The one remaining gap is ui-core's `uiNote`
// bypass, a second appender of `memory_written` that skips `store.write`: a note it rewrote with no
// claims would retire them with no tombstone, and this fold would still call them live. Unreachable
// today (ui-meta notes carry no claims) and deliberately left alone — the caller decides which
// events to feed, and this function cannot see a retirement that was never logged as one.
export function claimHistory(events: readonly ClaimEvent[]): ClaimInterval[] {
  const intervals: ClaimInterval[] = []
  const open = new Map<string, ClaimInterval>()
  for (const e of events) {
    const act: ClaimAct = { seq: e.seq, ts: e.ts, sourceRevision: e.sourceRevision, why: e.why, decision: e.decision, author: e.author }
    for (const c of e.claims) {
      const live = open.get(c.id)
      // a re-statement updates the stretch it is already in; a revival opens a new one
      if (live) Object.assign(live, { text: c.text, class: c.class, anchors: c.anchors, sourceRevision: c.sourceRevision })
      else {
        const started: ClaimInterval = {
          id: c.id, text: c.text, class: c.class, anchors: c.anchors, sourceRevision: c.sourceRevision,
          validFrom: e.ts, invalidatedAt: null, addedBy: act, retiredBy: null,
        }
        intervals.push(started)
        open.set(c.id, started)
      }
    }
    const close = (id: string, by: ClaimAct): void => {
      const live = open.get(id)
      // a tombstone for a claim this log never carried is ignored, exactly as resolveClaims ignores it
      if (!live) return
      Object.assign(live, { invalidatedAt: by.ts, retiredBy: by })
      open.delete(id)
    }
    // retirement is applied after addition, so it wins within one event exactly as in resolveClaims
    for (const id of e.invalidates) close(id, act)
    if (e.deleted) {
      const byDeletion: ClaimAct = { ...act, why: null, decision: null }
      for (const id of [...open.keys()]) close(id, byDeletion)
    }
  }
  return intervals
}
