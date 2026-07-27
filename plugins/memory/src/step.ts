import {
  errorMessage, LINK_KIND, MEMORY_ACCESS, MEMORY_LIMITS, MemoryScope, noteKey, NOTE_TIER, planScope, SIGNAL_OUTCOME, slugId, taskLaneScopes,
  type ClaimHit, type LinkKind, type MemoryAuthor, type MemoryStore, type NoteSummary, type ResolvedTool,
  type RecalledContext, type SignalOutcome, type StepMemory,
} from '@orc/contracts'
import { applyBudget, approxTokens } from './budget'
import { memoryTools, unavailableMemoryTools, MEMORY_ROLE, type MemoryRole } from './tools'
import type { ChangedSince } from './drift'

// Distinct id prefixes so a later success cannot overwrite a failure lesson — both notes coexist.
interface AmbientSpec { idPrefix: string; tags: readonly string[] }
const AMBIENT: Record<SignalOutcome, AmbientSpec> = {
  [SIGNAL_OUTCOME.success]: { idPrefix: 'step', tags: ['ambient'] },
  [SIGNAL_OUTCOME.failure]: { idPrefix: 'failed step', tags: ['ambient', 'failure'] },
}

// ONE derivation: the id a step writes and the id a sibling links to must match or the edge is dead.
export const ambientNoteId = (stepId: string): string => slugId(`${AMBIENT[SIGNAL_OUTCOME.success].idPrefix} ${stepId}`)

// Both kinds resolve under contracts/linkLookupScopes: a sibling's ambient note shares this note's
// plan scope, and a project note is reachable from any scope. Capped at the schema's own limit.
export function ambientLinks(dependsOn: readonly string[], readProjectIds: readonly string[]): Array<{ id: string; kind: LinkKind }> {
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
  changedSince?: ChangedSince
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
    const claims = applyBudget(claimHits, h => JSON.stringify(h), { limit: PRELOAD_MAX_NOTES, budget }).items
    const spent = claims.reduce((sum, c) => sum + approxTokens(JSON.stringify(c)), 0)
    const noteHits = await store.search(query, { scope }, {})
    const notes = applyBudget(noteHits, n => JSON.stringify(n), {
      limit: PRELOAD_MAX_NOTES, budget: Math.max(0, budget - spent),
    }).items
    return { claims, notes }
  }

  return {
    tools: memoryTools({ store: tracking, author, role: opts.role, changedSince: opts.changedSince, searchScope: scope }),
    memory: {
      // KEYWORD arm only, deliberately: a path is a literal, and the semantic arm would return
      // claims that are merely about the same area — which is the opposite of what a retirement
      // prompt needs. A false candidate costs the agent a judgement call it did not need to make,
      // and enough of those teach it to skim the block.
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
              for (const hit of await store.searchClaims(term, { scope }, { limit: MEMORY_LIMITS.detailItems }))
                if (hit.text.includes(term)) seen.set(hit.claimId, hit) // the store ranks; we require the literal
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
          for (const n of touched.values())
            await tracking.recordAccess(n.id, n.scope, MEMORY_ACCESS.preload, author, {
              // keyed by note, not position: a replay that reorders results must still converge
              ...(author.runToken ? { idempotencyKey: `${author.runToken}:preload:${n.scope}:${n.id}` } : {}),
            })
          return found
        } catch (err) {
          console.warn(`memory recall failed for step '${step.id}':`, errorMessage(err))
          return { claims: [], notes: [] }
        }
      },

      async capture(signal) {
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
export type BindStep = (p: Omit<Parameters<typeof bindStepMemory>[0], 'store' | 'changedSince'>) => StepMemoryBinding

// Degraded mode (design §8.4): the tools still EXIST and every call returns an explicit isError
// naming the reason, so the model learns context is unavailable instead of silently losing them.
// recall/capture go quiet rather than erroring — neither is the model's call to make.
export const unavailableStepMemory = (reason: string): StepMemoryBinding => ({
  tools: unavailableMemoryTools(reason),
  // claimsCiting joins the same quiet set: with no read model there is nothing to put at risk, and
  // an advisory nudge must never be the thing that fails a step.
  memory: { recall: async () => ({ claims: [], notes: [] }), claimsCiting: async () => [], capture: async () => {} },
})
