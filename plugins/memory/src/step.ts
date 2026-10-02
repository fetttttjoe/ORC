import {
  errorMessage, LINK_KIND, MEMORY_LIMITS, MemoryScope, NOTE_TIER, planScope, SignalOutcome, slugId, taskLaneScopes,
  type LinkKind, type MemoryAuthor, type MemoryStore, type ResolvedTool, type StepMemory,
} from '@orc/contracts'
import { memoryTools, unavailableMemoryTools } from './tools'
import type { DriftSources } from './claim-drift-read'
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

export interface StepMemoryBinding {
  tools: ResolvedTool[]
  memory: StepMemory
}

const kept = (tools: ResolvedTool[], keep: readonly string[] | undefined): ResolvedTool[] =>
  keep === undefined ? tools : tools.filter(t => keep.includes(t.name))

// Everything a running step does to memory, in one place: the tool surface it hands the model and
// the note it leaves behind. The executor only decides WHEN the note is written.
export function bindStepMemory(opts: {
  store: MemoryStore
  author: MemoryAuthor
  step: { id: string; title: string; dependsOn: readonly string[] }
  taskId: string
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
  keep?: readonly string[]
}): StepMemoryBinding {
  const { store, author, step, taskId } = opts
  // Every durable note this step pulled. Collected by decorating the ONE method that already means
  // "a pull was delivered" — recordAccess fires on a hit only — so reads and traversal seeds count
  // under one rule.
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
  return {
    tools: kept(memoryTools({ store: tracking, author, ...(opts.drift && { drift: opts.drift }), workspaceView: opts.workspaceView, catchUp: opts.catchUp, searchScope: scope }), opts.keep),
    memory: {
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
// capture goes quiet rather than erroring — it is not the model's call to make.
export const unavailableStepMemory = (reason: string, keep?: readonly string[]): StepMemoryBinding => ({
  tools: kept(unavailableMemoryTools(reason), keep),
  memory: { capture: async () => {} },
})
