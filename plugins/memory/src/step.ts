import {
  errorMessage, LINK_KIND, MEMORY_ACCESS, MEMORY_LIMITS, MemoryScope, noteKey, NOTE_TIER, planScope, SignalOutcome, slugId, taskLaneScopes,
  type ClaimInput, type LinkKind, type MemoryAuthor, type MemoryStore, type ResolvedTool,
  type RecalledContext, type StepMemory,
} from '@orc/contracts'
import { applyBudget } from './budget'
import { memoryTools, unavailableMemoryTools } from './tools'
import { readCorpusDrift, type DriftableNote, type DriftSources } from './claim-drift-read'
import type { CorpusDrift } from './drift'
import type { WorkspaceViewProbe } from './provisional'

// Distinct id prefixes so a later success cannot overwrite a failure lesson — both notes coexist.
// `partial` is null — NO ambient note: continuation rounds share a runToken, so the ambient
// idempotency key (`${runToken}:ambient:${prefix}:${stepId}`) would collide across rounds and the
// interim summary would swallow the terminal one. The final signal writes the durable note; a
// partial's summary travels to the next round via the port's continuation ctx, not the graph.
interface AmbientSpec { idPrefix: string; tags: readonly string[] }
// the success prefix, spelled once: AMBIENT uses it for the note the step writes, ambientNoteId
// for the id a SIBLING links to — one drifting from the other is a dead edge
const STEP_NOTE_PREFIX = 'step'
const AMBIENT: Record<SignalOutcome, AmbientSpec | null> = {
  [SignalOutcome.success]: { idPrefix: STEP_NOTE_PREFIX, tags: ['ambient'] },
  [SignalOutcome.failure]: { idPrefix: `failed ${STEP_NOTE_PREFIX}`, tags: ['ambient', 'failure'] },
  [SignalOutcome.partial]: null,
}

// ONE derivation: the id a step writes and the id a sibling links to must match or the edge is dead.
// Not exported: only this file's own ambientLinks/capture call it — see index.ts's rule that a
// re-export nobody imports is compatibility debt for no consumer.
const ambientNoteId = (stepId: string): string => slugId(`${STEP_NOTE_PREFIX} ${stepId}`)

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

const kept = (tools: ResolvedTool[], keep: readonly string[] | undefined): ResolvedTool[] =>
  keep === undefined ? tools : tools.filter(t => keep.includes(t.name))

// Everything a running step does to memory, in one place: the tool surface it hands the model, the
// context it is given before its first prompt, and the note it leaves behind. The executor only
// decides WHEN each happens.
export function bindStepMemory(opts: {
  store: MemoryStore
  author: MemoryAuthor
  step: { id: string; title: string; instructions: string; dependsOn: readonly string[] }
  taskId: string
  // the drift probes: also what lets recall report how much of its own output still holds
  drift?: DriftSources
  // the workspace standing behind the tools' `provisional` flag — bound by the composition root for
  // the same reason changedSince is: neither can be answered from inside one step
  workspaceView?: WorkspaceViewProbe
  // drains the projection before the step's own reads — see memoryTools' catchUp
  catchUp?: () => Promise<void>
  ambientCapture?: boolean
  // nearest first (parent, grandparent, …, root) — a split child's decomposition lives in its
  // PARENT's plan scope, so without these it cannot see its own subplan
  ancestorTaskIds?: readonly string[]
  // Bound on the advisory read path (recall). The degrade contract ("never block
  // the step") only held against THROWS — a dead SurrealDB socket pends forever (measured:
  // connect() still pending after 400s), and a step recovered mid-boot wedged in recall with
  // zero events for 10+ minutes, live 2026-08-04. Injectable so the tests need not wait it out.
  recallTimeoutMs?: number
  keep?: readonly string[]
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
    const drift = opts.drift
    if (!drift) return undefined
    try {
      // BOTH arms. Claims take the budget first, so at the default budget a block is typically
      // several claims and one note — computing currency from the notes alone put most of what the
      // step was handed under a verdict that never examined it. Deduped by owning note: a claim's
      // checkable unit IS its note (a claim declares no paths of its own), so five claims from one
      // note must not count that note five times and drown the notes arm.
      // NOTES second, so a note that appears in both arms wins the key: only the note summary
      // carries `verified`, and dropping it here would leave the preload's verdict blind to every
      // verification an auditor ever declared (the same slip tools.ts's search flagging had).
      // a matched claim is judged on its own anchors; several claims of one note accumulate
      const byNote = new Map<string, DriftableNote>()
      for (const c of found.claims) {
        const held = byNote.get(noteKey(c.scope, c.noteId))
        const claim: ClaimInput = { id: c.claimId, text: c.text, class: c.class, anchors: c.anchors, sourceRevision: c.sourceRevision }
        byNote.set(noteKey(c.scope, c.noteId), { sourceRevision: c.sourceRevision, paths: c.paths, claims: [...(held?.claims ?? []), claim] })
      }
      for (const n of found.notes) {
        const held = byNote.get(noteKey(n.scope, n.id))
        byNote.set(noteKey(n.scope, n.id), { sourceRevision: n.sourceRevision, paths: n.paths, ...(held?.claims && { claims: held.claims }), ...(n.verified && { verified: n.verified }) })
      }
      const d = await readCorpusDrift([...byNote.values()], drift)
      return (d.checkable === 0 && d.unknown === 0) ? undefined : d
    } catch { return undefined }
  }

  // A generous ceiling: a healthy recall is three searches plus a drift probe, seconds even on a
  // CPU embedder — this exists for the pending-forever socket, not for slow-but-alive.
  // [conjecture — sized from observed healthy recalls well under 5s; grep this name before tuning]
  const recallTimeoutMs = opts.recallTimeoutMs ?? 30_000
  // The hang-shaped half of the degrade contract: a promise that never settles cannot be caught, so recall races a timer and the CALLER's own catch turns the timeout into the same "no notes" the throwing store already gets.
  const bounded = <T>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} still pending after ${recallTimeoutMs}ms — degraded store treated as absent`)), recallTimeoutMs).unref?.())])

  return {
    tools: kept(memoryTools({ store: tracking, author, ...(opts.drift && { drift: opts.drift }), workspaceView: opts.workspaceView, catchUp: opts.catchUp, searchScope: scope }), opts.keep),
    memory: {
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
          return await bounded((async () => {
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
          })(), `memory recall for step '${step.id}'`)
        } catch (err) {
          console.warn(`memory recall failed for step '${step.id}':`, errorMessage(err))
          return { claims: [], notes: [] }
        }
      },

      async capture(signal) {
        if (opts.ambientCapture === false || !signal.summary) return
        const spec = AMBIENT[signal.outcome]
        if (spec === null) return // partial: interim state, no durable note (see AMBIENT's comment)
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
export type BindStep = (p: Omit<Parameters<typeof bindStepMemory>[0], 'store' | 'changedSince' | 'workspaceView' | 'catchUp'>) => StepMemoryBinding

// Degraded mode: the tools still EXIST and every call returns an explicit isError
// naming the reason, so the model learns context is unavailable instead of silently losing them.
// recall/capture go quiet rather than erroring — neither is the model's call to make.
export const unavailableStepMemory = (reason: string, keep?: readonly string[]): StepMemoryBinding => ({
  tools: kept(unavailableMemoryTools(reason), keep),
  memory: { recall: async () => ({ claims: [], notes: [] }), capture: async () => {} },
})
