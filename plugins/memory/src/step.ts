import {
  claimHitKey, errorMessage, LINK_KIND, MEMORY_ACCESS, MEMORY_LIMITS, MEMORY_USE, MemoryScope, noteKey, NOTE_TIER, planScope, SEARCH_MODE, SIGNAL_OUTCOME, slugId, taskLaneScopes,
  type ClaimHit, type VerifiedStamp, type LinkKind, type MemoryAuthor, type MemoryStore, type NoteSummary, type ResolvedTool,
  type RecalledContext, type SignalOutcome, type StepMemory,
} from '@orc/contracts'
import { applyBudget } from './budget'
import { memoryTools, unavailableMemoryTools, MEMORY_ROLE, type MemoryRole } from './tools'
import { corpusDrift, type ChangedSince, type CorpusDrift } from './drift'

// Distinct id prefixes so a later success cannot overwrite a failure lesson — both notes coexist.
interface AmbientSpec { idPrefix: string; tags: readonly string[] }
const AMBIENT: Record<SignalOutcome, AmbientSpec> = {
  [SIGNAL_OUTCOME.success]: { idPrefix: 'step', tags: ['ambient'] },
  [SIGNAL_OUTCOME.failure]: { idPrefix: 'failed step', tags: ['ambient', 'failure'] },
}

// ONE derivation: the id a step writes and the id a sibling links to must match or the edge is dead.
// Not exported: only this file's own ambientLinks/capture call it — see index.ts's rule that a
// re-export nobody imports is compatibility debt for no consumer.
const ambientNoteId = (stepId: string): string => slugId(`${AMBIENT[SIGNAL_OUTCOME.success].idPrefix} ${stepId}`)

// Both kinds resolve under contracts/linkLookupScopes: a sibling's ambient note shares this note's
// plan scope, and a project note is reachable from any scope. Capped at the schema's own limit.
// Not exported: only capture() below calls it.
function ambientLinks(dependsOn: readonly string[], readProjectIds: readonly string[]): Array<{ id: string; kind: LinkKind }> {
  return [
    ...dependsOn.map(id => ({ id: ambientNoteId(id), kind: LINK_KIND.depends_on })),
    ...readProjectIds.map(id => ({ id, kind: LINK_KIND.derived_from })),
  ].slice(0, MEMORY_LIMITS.detailItems)
}

// Preload is a HINT: the knowledge protocol tells the agent to search for whatever the block lacks,
// so a handful of best-ranked notes beats everything that fit in the budget. The model's own
// memory_search stays at its larger limit — that one is a request, not a suggestion.
const PRELOAD_MAX_NOTES = 5

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'your', 'have', 'will', 'were', 'been', 'being',
  'their', 'about', 'after', 'before', 'which', 'while', 'where', 'there', 'these', 'those',
  'when', 'what', 'then', 'than', 'over', 'under', 'onto', 'also', 'each', 'such', 'only',
  'both', 'more', 'most', 'some', 'them', 'they', 'step', 'task',
])

// Keyword-only fallback: with no embedder, prose ANDs to nothing and a few rare title words are
// what still match.
export function deriveQueryTerms(title: string): string[] {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const terms: string[] = []
  for (const w of words) {
    if (w.length < 4 || STOPWORDS.has(w)) continue
    terms.push(w)
    if (terms.length === 3) break
  }
  return terms
}

// The step's intent as a natural-language query for the semantic arm — bounded, since the query is
// embedded and unbounded prose dilutes.
export const preloadQuery = (step: { title: string; instructions: string }): string =>
  `${step.title}\n${step.instructions}`.trim().slice(0, 600)

export interface StepMemoryBinding {
  tools: ResolvedTool[]
  memory: StepMemory
}

// Everything a running step does to memory, in one place: the tool surface it hands the model, the
// context it is given before its first prompt, and the note it leaves behind. The executor only
// decides WHEN each happens.
export function bindStepMemory(opts: {
  store: MemoryStore
  author: MemoryAuthor
  step: { id: string; title: string; instructions: string; dependsOn: readonly string[] }
  taskId: string
  role?: MemoryRole
  // the drift probe: also what lets recall report how much of its own output still holds
  changedSince?: ChangedSince
  // drains the projection before the step's own reads — see memoryTools' catchUp
  catchUp?: () => Promise<void>
  ambientCapture?: boolean
  // nearest first (parent, grandparent, …, root) — a split child's decomposition lives in its
  // PARENT's plan scope, so without these it cannot see its own subplan
  ancestorTaskIds?: readonly string[]
}): StepMemoryBinding {
  const { store, author, step, taskId } = opts
  // Every durable note this step pulled. Collected by decorating the ONE method that already means
  // "a pull was delivered" — recordAccess fires on a hit only — so preload, reads and traversal
  // seeds all count under one rule.
  const pulled = new Set<string>()
  // What this step AUTHORED. Reading your own output back is verification, not provenance — a real
  // run wrote a note, re-read it to check, and cited itself as the source.
  const authored = new Set<string>()
  const tracking: MemoryStore = {
    ...store,
    recordAccess: async (id, scope, mode, a, o) => {
      if ((scope ?? MemoryScope.project) === MemoryScope.project) pulled.add(id)
      return store.recordAccess(id, scope, mode, a, o)
    },
    write: async (draft, a, o) => {
      const written = await store.write(draft, a, o)
      authored.add(written.id)
      return written
    },
  }

  const scope = taskLaneScopes(taskId, opts.ancestorTaskIds)
  // Claims take their share of the budget FIRST — a matched statement is what the step can act on,
  // where a note summary is a pointer it must spend a memory_read to follow. Notes get the
  // remainder rather than a second full budget, so one preload costs what the caller allotted.
  const search = async (query: string, budget: number): Promise<RecalledContext> => {
    const claimHits = await store.searchClaims(query, { scope }, { limit: PRELOAD_MAX_NOTES })
    // Measured on the SERIALIZED hit, like the note arm below: a ClaimHit ships
    // claimId/noteId/scope/title/validFrom too, and costing only `text` undercounted the preload by
    // several hundred chars per hit — the notes arm then spent a remainder that was never free.
    const claims = applyBudget(claimHits, h => JSON.stringify(h), { limit: PRELOAD_MAX_NOTES, budget })
    const noteHits = await store.search(query, { scope }, {})
    const notes = applyBudget(noteHits, n => JSON.stringify(n), {
      limit: PRELOAD_MAX_NOTES, budget: Math.max(0, budget - claims.used),
    }).items
    return { claims: claims.items, notes }
  }

  // How much of what we are about to hand over still describes the tree in front of the step —
  // `corpusDrift`, the same verdict memory_read flags per note and `orc status` reports per corpus.
  // Deliberately NOT a second, cheaper comparison: `sourceRevision === HEAD` was tried here and is
  // strictly worse, because any commit anywhere invalidates every note at once (measured: two
  // commits over eight files scored 0 of 42 "current" while only 11 of 18 checkable notes had
  // actually moved), so the block would tell every step to re-derive everything — the exact cost
  // the preload exists to avoid.
  //
  // Every failure folds to undefined, matching the module's rule that unknown is never "drifted"
  // and never "current": a git probe that cannot answer must not produce a sentence.
  const currencyOf = async (found: RecalledContext): Promise<CorpusDrift | undefined> => {
    if (!opts.changedSince) return undefined
    try {
      // BOTH arms. Claims take the budget first, so at the default budget a block is typically
      // several claims and one note — computing currency from the notes alone put most of what the
      // step was handed under a verdict that never examined it. Deduped by owning note: a claim's
      // checkable unit IS its note (a claim declares no paths of its own), so five claims from one
      // note must not count that note five times and drown the notes arm.
      // NOTES second, so a note that appears in both arms wins the key: only the note summary
      // carries `verified`, and dropping it here would leave the preload's verdict blind to every
      // verification an auditor ever declared (the same slip tools.ts's search flagging had).
      const byNote = new Map<string, { sourceRevision: string | null; paths: readonly string[]; verified?: VerifiedStamp }>()
      for (const c of found.claims) byNote.set(noteKey(c.scope, c.noteId), { sourceRevision: c.sourceRevision, paths: c.paths })
      for (const n of found.notes) byNote.set(noteKey(n.scope, n.id), { sourceRevision: n.sourceRevision, paths: n.paths, ...(n.verified && { verified: n.verified }) })
      const d = await corpusDrift([...byNote.values()], opts.changedSince)
      return (d.checkable === 0 && d.unknown === 0) ? undefined : d
    } catch { return undefined }
  }

  return {
    tools: memoryTools({ store: tracking, author, role: opts.role, changedSince: opts.changedSince, catchUp: opts.catchUp, searchScope: scope }),
    memory: {
      // KEYWORD arm only, and now actually PASSED as such: a path is a literal, and the semantic
      // arm returns claims merely about the same area — the opposite of what a retirement prompt
      // needs. Omitting the mode meant every embedder-configured deployment silently ran hybrid,
      // and the fused semantic winner then failed the literal `includes` filter below, so a genuinely
      // citing note could contribute nothing at all.
      //
      // perNote 'all' because this ENUMERATES: the default collapses to the best claim per note, so
      // a note asserting three claims about the edited file surfaced one and silently withheld two
      // the same change had falsified.
      //
      // Degraded store folds to "nothing at risk": this is an advisory nudge, and failing the step
      // because the read model is down would be worse than missing a retirement.
      async claimsCiting(paths) {
        const seen = new Map<string, ClaimHit>()
        for (const path of paths) {
          // the basename too: a claim commonly cites `cluster.ts` where the edit names the full
          // path, and requiring an exact-string match would find neither
          for (const term of [path, path.split('/').pop() ?? '']) {
            if (term.length < 3) continue
            try {
              for (const hit of await store.searchClaims(term, { scope }, { limit: MEMORY_LIMITS.detailItems, mode: SEARCH_MODE.keyword, perNote: 'all' }))
                // keyed by (scope, note, claim), not claimId alone: that id hashes the claim's TEXT,
                // so two notes asserting the same sentence share it and one of them vanished here —
                // the same silent withholding `perNote: 'all'` above exists to prevent
                if (hit.text.includes(term)) seen.set(claimHitKey(hit), hit) // the store ranks; we require the literal
            } catch { /* degraded: nothing at risk rather than a failed step */ }
          }
        }
        return [...seen.values()].slice(0, MEMORY_LIMITS.detailItems)
      },
      // Semantic-first, then degrade: full intent (hybrid matches meaning) → distinctive title
      // terms (what keyword-only deployments need) → the single longest term. First non-empty wins.
      // A degraded store must never block the step, so every failure folds to "no notes".
      async recall(budget) {
        if (budget <= 0) return { claims: [], notes: [] }
        const terms = deriveQueryTerms(step.title)
        // Ordered candidates, first non-empty wins: the full intent (hybrid search matches meaning),
        // then the distinctive title terms (what a keyword-only deployment needs, since prose ANDs
        // to nothing there), then the single longest term (a rare word narrows less than an AND).
        const candidates = [
          preloadQuery(step),
          terms.join(' '),
          terms.length > 1 ? terms.reduce((a, b) => (b.length > a.length ? b : a)) : '',
        ].filter(Boolean)
        try {
          let found: RecalledContext = { claims: [], notes: [] }
          for (const query of candidates) {
            found = await search(query, budget)
            if (found.claims.length > 0 || found.notes.length > 0) break
          }
          // Access is recorded per NOTE, and a claim's access is its owner's: the activation signal
          // the lifecycle is tuned on counts notes, so a claim hit must not double-count its note.
          // noteKey, not a hand-rolled `${scope} ${id}`: the same composite key claim-search's
          // dedupeByNote and surreal's fusion maps use, so there is one spelling of the format
          const touched = new Map(
            [...found.claims.map(c => [noteKey(c.scope, c.noteId), { id: c.noteId, scope: c.scope }] as const),
             ...found.notes.map(n => [noteKey(n.scope, n.id), { id: n.id, scope: n.scope }] as const)])
          // Recorded BEST-EFFORT, one note at a time. recordAccess appends to Postgres under the
          // per-project advisory lock, so live contention or a connection blip throws — and it threw
          // INSIDE the try that wraps the whole recall, so one failed counter discarded a preload
          // that had already been retrieved successfully. The step then ran with no knowledge at
          // all, while the accesses appended before the failure claimed it had read notes it never
          // saw. An activation counter is a signal; the knowledge is the product.
          for (const n of touched.values()) {
            try {
              await tracking.recordAccess(n.id, n.scope, MEMORY_ACCESS.preload, author, {
                // keyed by note, not position: a replay that reorders results must still converge
                ...(author.runToken ? { idempotencyKey: `${author.runToken}:preload:${n.scope}:${n.id}` } : {}),
              })
            } catch (err) {
              console.warn(`preload access not recorded for '${n.id}': ${errorMessage(err)}`)
            }
          }
          // measured on what is actually delivered, after the budget cut — a note that did not fit
          // is not knowledge this step was handed, so it must not move the reading either way
          const currency = await currencyOf(found)
          return { ...found, ...(currency && { currency }) }
        } catch (err) {
          console.warn(`memory recall failed for step '${step.id}':`, errorMessage(err))
          return { claims: [], notes: [] }
        }
      },

      async capture(signal) {
        // Knowledge FIRST and unconditionally: outcome evidence is a different concern than the
        // ambient step note, so the ambientCapture knob must not silence it. Deduped per side —
        // an agent restating an id is one report, not two — while an id honestly reported on BOTH
        // sides stays two events (contested is the truthful reading). Contained like the ambient
        // write below: advisory evidence must never fail the step that volunteered it.
        const k = signal.knowledge
        if (k && (k.useful.length > 0 || k.deadEnd.length > 0)) {
          try {
            await store.recordOutcomes([
              ...[...new Set(k.useful)].map(id => ({ id, outcome: MEMORY_USE.useful })),
              ...[...new Set(k.deadEnd)].map(id => ({ id, outcome: MEMORY_USE.dead_end })),
            ], author, author.runToken ? { idempotencyKeyBase: `${author.runToken}:knowledge` } : {})
          } catch (err) {
            console.warn(`knowledge capture failed for step '${step.id}':`, errorMessage(err))
          }
        }
        if (opts.ambientCapture === false || !signal.summary) return
        const spec = AMBIENT[signal.outcome]
        try {
          await store.write({
            // keyed by step id (unique in a plan), not the free-form title: two same-titled steps
            // must not collide and lose one's lesson
            id: slugId(`${spec.idPrefix} ${step.id}`),
            scope: planScope(taskId),
            title: step.title.slice(0, 200),
            summary: signal.summary.slice(0, 500),
            tags: [...spec.tags],
            links: ambientLinks(step.dependsOn, [...pulled].filter(id => !authored.has(id))),
            // a record of what one run did, not a claim about the project — the tier is what makes
            // it expirable and sweepable by construction
            tier: NOTE_TIER.episodic,
          }, author, {
            ...(author.runToken ? { idempotencyKey: `${author.runToken}:ambient:${spec.idPrefix}:${step.id}` } : {}),
          })
        } catch (err) {
          console.warn(`ambient capture failed for step '${step.id}':`, errorMessage(err))
        }
      },
    },
  }
}

// What the composition root calls per step, with the store already bound.
export type BindStep = (p: Omit<Parameters<typeof bindStepMemory>[0], 'store' | 'changedSince' | 'catchUp'>) => StepMemoryBinding

// Degraded mode (design §8.4): the tools still EXIST and every call returns an explicit isError
// naming the reason, so the model learns context is unavailable instead of silently losing them.
// recall/capture go quiet rather than erroring — neither is the model's call to make.
export const unavailableStepMemory = (reason: string): StepMemoryBinding => ({
  tools: unavailableMemoryTools(reason),
  // claimsCiting joins the same quiet set: with no read model there is nothing to put at risk, and
  // an advisory nudge must never be the thing that fails a step.
  memory: { recall: async () => ({ claims: [], notes: [] }), claimsCiting: async () => [], capture: async () => {} },
})
