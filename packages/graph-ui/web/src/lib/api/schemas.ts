import { z } from 'zod'
// relative, not the $lib alias: the e2e contract test imports this file from the graph-ui
// package, whose tsconfig knows nothing about the web app's path aliases
import { ArtifactDetail, ModelDetail, NoteDetail, StepDetail, TaskDetail } from '../features/inspector/detail-view'

// re-exported so the contract test can assert each node kind against the schema its view uses
export { ArtifactDetail, ModelDetail, NoteDetail, StepDetail, TaskDetail }

/**
 * The response shape of every endpoint, as data rather than as a type assertion.
 *
 * A `get<T>()` cast is erased at build time, so a server that renames a field or moves it a level
 * deeper produces an empty render and nothing else — measured on this app: the model picker sat
 * permanently empty (a bare array read as `{refs}`), artifacts fell through to "unrecognised
 * shape", a model's whole cost lens went blank, and a note's claims never appeared. Every one of
 * those was invisible until someone looked at the screen.
 *
 * Parsing here turns each of them into ONE loud error naming the endpoint and the field path, and
 * lets e2e/contract.pw.ts assert the live server still satisfies them.
 */

const GraphNode = z.object({
  id: z.string(),
  type: z.enum(['task', 'step', 'artifact', 'note', 'model']),
  label: z.string(),
  detail: z.string(),
  heat: z.number().optional(),
})
const GraphLink = z.object({ source: z.string(), target: z.string(), type: z.string(), heat: z.number().optional() })

export const GraphSnapshot = z.object({ seq: z.number(), nodes: z.array(GraphNode), links: z.array(GraphLink) })

export const SessionInfo = z.object({
  projectId: z.string().nullable(),
  actions: z.boolean(),
  copilot: z.boolean(),
  token: z.string().optional(),
  copilotModel: z.string().nullable().optional(),
  defaultCwd: z.string().nullable().optional(),
  bootedAt: z.string().optional(),
})

export const ProjectList = z.array(z.object({ id: z.string(), name: z.string().nullable(), dir: z.string().nullable().optional() }))

const MemoryHealth = z.object({
  state: z.enum(['ok', 'catching_up', 'unreachable']),
  pending: z.number(),
  reason: z.string().optional(),
  drift: z.object({ checkable: z.number(), drifted: z.number(), ratio: z.number() }).optional(),
  // what the projector is doing right now; absent when idle. `pending` covers only the event
  // replay, so the slow stages after it (linking, ollama re-clustering) report through this.
  stage: z.object({ name: z.string(), sinceMs: z.number() }).optional(),
})
export const Health = z.object({
  memory: MemoryHealth.nullable(),
  supervisor: z.object({ state: z.enum(['ready', 'booting', 'stale', 'none']), pid: z.number().optional(), lastSeenAt: z.string().optional() }).optional(),
})

const CopilotExchange = z.object({
  user: z.string(),
  assistant: z.string(),
  toolCalls: z.array(z.object({ toolName: z.string(), summary: z.string() })).default([]),
  modelRef: z.string(),
})

export const LogRows = z.array(
  z.object({
    seq: z.number(),
    ts: z.string(),
    kind: z.string(),
    line: z.string(),
    taskId: z.string().nullable(),
    stepId: z.string().nullable(),
    noteRef: z.string().nullable().optional(),
    authorTaskId: z.string().nullable().optional(),
    failure: z.object({ toolName: z.string(), error: z.string() }).nullable().optional(),
    // the chat pane rebuilds real bubbles from these rather than from browser storage
    exchange: CopilotExchange.nullable().optional(),
  }),
)

export const Transcript = z.array(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('message'), iteration: z.number(), stepId: z.string(), text: z.string() }),
    z.object({
      kind: z.literal('tool'),
      iteration: z.number(),
      stepId: z.string(),
      toolName: z.string(),
      input: z.unknown(),
      output: z.unknown(),
      isError: z.boolean(),
    }),
    z.object({ kind: z.literal('question'), stepId: z.string(), question: z.string(), answer: z.string().nullable() }),
    z.object({ kind: z.literal('signal'), stepId: z.string(), outcome: z.string(), summary: z.string() }),
  ]),
)

const WaveStep = z.object({ id: z.string(), title: z.string(), status: z.string(), failureClass: z.string().optional() })
export const PlansView = z.object({
  versions: z.array(
    z.object({
      taskId: z.string(),
      version: z.number(),
      strategyRef: z.string(),
      analyzerRef: z.string().optional(),
      costEstimateUSD: z.number().nullable(),
      // Every field PlanDraft REQUIRES must survive this parse, not just the ones the read views
      // render: `reopen plan for editing` posts these steps straight back as a new version, and a
      // schema that dropped executorRef/isolation made the server refuse the draft — a replan
      // button that looked wired and could never succeed.
      steps: z.array(
        z.object({
          id: z.string(),
          role: z.string(),
          title: z.string(),
          instructions: z.string(),
          executorRef: z.string(),
          isolation: z.string(),
          modelRef: z.string().optional(),
          dependsOn: z.array(z.string()).default([]),
          zone: z.array(z.string()).default([]),
          skillRefs: z.array(z.string()).default([]),
          toolRefs: z.array(z.string()).default([]),
          maxIterations: z.number().optional(),
        }),
      ),
    }),
  ),
  approvedVersion: z.number().nullable(),
  visual: z
    .object({
      version: z.number(),
      waves: z.array(z.object({ wave: z.number(), parallel: z.boolean(), steps: z.array(WaveStep) })),
    })
    .nullable(),
})

export const PlanNotesView = z.object({
  notes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string().default(''),
      body: z.string().default(''),
      rationale: z.string().default(''),
      uncertainty: z.array(z.string()).default([]),
      links: z.array(z.object({ id: z.string(), kind: z.string() })).default([]),
      dependsOn: z.array(z.string()).default([]),
      zone: z.array(z.string()).default([]),
      modelRef: z.string().optional(),
    }),
  ),
})

/** the models catalog is a BARE array of refs — the `{refs}` wrapper it never had cost a flow */
export const ModelRefs = z.array(z.string())

/**
 * `/api/node` answers with a different shape per node kind. Unknown shapes stay legal (the view
 * renders a labelled raw record) — a NEW node kind must not break the pane — but the five known
 * ones are pinned, so a rename inside any of them fails the contract test.
 */
export const NodeDetail = z.union([TaskDetail, StepDetail, NoteDetail, ArtifactDetail, ModelDetail, z.record(z.string(), z.unknown())])

// ---- the live stream ----

const GraphPatch = z.object({
  addNodes: z.array(GraphNode).default([]),
  updateNodes: z.array(GraphNode).default([]),
  removeNodeIds: z.array(z.string()).default([]),
  addLinks: z.array(GraphLink).default([]),
  updateLinks: z.array(GraphLink).default([]),
  removeLinks: z.array(GraphLink).default([]),
})

/**
 * An SSE frame. This carries the whole live experience — a malformed one used to be cast, so a
 * server-side rename would have corrupted the graph store silently rather than failing. Rejected
 * frames are dropped and reported, never applied half-parsed.
 */
export const Envelope = z.object({
  patch: GraphPatch.nullable().optional(),
  summary: LogRows.element.nullable().optional(),
  projects: ProjectList.optional(),
})

// ---- action results ----
// Only the shapes a caller actually reads are pinned; an action whose result the UI ignores
// stays unknown rather than inventing a contract nobody depends on.
export const TaskCreated = z.object({ taskId: z.string().min(1) })
export const ReplyResult = z.object({ answered: z.boolean(), supervised: z.boolean() })
export const ApprovedVersion = z.object({ version: z.number() })
export const NoteWritten = z.object({ id: z.string(), scope: z.string().optional() })
/** purge/delete report what they removed and anything they could not */
export const PurgeReport = z.object({ events: z.number().optional(), operations: z.number().optional(), warnings: z.array(z.string()).default([]) })

// ---- persisted client state ----
/** the copilot history in localStorage is untrusted input like any other wire */
export const StoredChat = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
