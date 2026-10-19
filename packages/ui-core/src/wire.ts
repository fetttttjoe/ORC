import { z } from 'zod'
// the event vocabulary comes from contracts, never a second spelling: event-kinds.ts is a leaf
// module (zod + a type-only import), so the browser can take it without the rest of @orc/contracts
import { EventKind } from '@orc/contracts/event-kinds'
// guards.ts is a leaf too (zod only) — one spelling of error→string, browser bundle included
import { errorMessage } from '@orc/contracts/guards'
// A read's scope and a chat's digest are the SAME schemas the derivations parse: a second spelling
// of either on the wire is a shape the browser could hold and no view could answer.
import { Scope } from '@orc/contracts/scope'
import { ChatDigest } from '@orc/contracts/chat-digest'
import { Door } from '@orc/contracts/origin'
import type { PlanNote } from '@orc/contracts/plan-note'
import { NODE_TYPES, type NodeType } from './graph-wire'

// The node vocabulary as a schema, derived from NODE_TYPES rather than re-listed: the node view
// answers about a node the GRAPH emitted, so the kind it answers with IS that node's `type`, and
// there is no room here for a second spelling of the same words.
export const NODE_KIND = z.enum(NODE_TYPES).enum

// The view registry: every read the browser can ask for, named once — the same reason
// graph-wire.ts's NODE_TYPES exists, so a view name is never re-spelled at a call site. `WIRE`
// below is keyed by `VIEW` and `satisfies Record<ViewName, ...>`, so a view added here without a
// matching params/result pair fails the build instead of turning into a runtime 404.
export const ViewName = z.enum(['timeline', 'chats', 'node', 'transcript', 'plans', 'planNotes', 'models', 'operatorState'])
export type ViewName = z.infer<typeof ViewName>
export const VIEW = ViewName.enum

/** Every name a stream frame can report as STALE, derived from ViewName's options so a view is touchable the moment it exists. */
export const TouchableName = z.enum(ViewName.options)
export type TouchableName = z.infer<typeof TouchableName>
export const TOUCHABLE = TouchableName.enum

/**
 * The view route's URL vocabulary, spoken by the server that reads it and the client that builds
 * it — the same rule as graph-wire's linkKey: a name on the wire lives at the wire.
 *
 * Params travel as ONE url-encoded JSON value rather than flattened query keys because a view's
 * params are typed objects (a kind list, seq numbers), and re-deriving those types from strings per
 * view is the hand-rolled validation zod replaced everywhere else here.
 */
export const VIEW_ROUTE = { prefix: '/api/view/', params: 'q' } as const

/** the project a project-scoped GET names — one spelling for every door that reads it */
export const PROJECT_PARAM = 'project'

/**
 * One view read's URL. `project` is required rather than left to the caller because a view is
 * answered out of one project's read model, so a view URL without one names no read — and because
 * it is what decides whether `q` joins with `?` or `&`, the join that was got wrong in two
 * different hand-built copies of this format.
 *
 * Absent params mean NO `q` at all, which `viewParams` below reads back as no params.
 */
export const viewPath = (name: string, project: string, params?: unknown): string =>
  `${VIEW_ROUTE.prefix}${name}?${PROJECT_PARAM}=${encodeURIComponent(project)}`
  + (params === undefined ? '' : `&${VIEW_ROUTE.params}=${encodeURIComponent(JSON.stringify(params))}`)

/**
 * The mirror of `viewPath`, and here beside it so the two halves of the format cannot drift: what a
 * door received under `q`. An absent `q` is no params, not a failure — a view whose params are all
 * optional is asked for by name alone.
 *
 * Returns the failure rather than throwing: malformed JSON is a bad REQUEST, which a door answers
 * 400 naming the parameter, where an empty answer would read as "this project has nothing".
 */
export const viewParams = (q: string | null): { ok: true; params: unknown } | { ok: false; error: string } => {
  if (q === null) return { ok: true, params: {} }
  try {
    return { ok: true, params: JSON.parse(q) }
  } catch (err) {
    return { ok: false, error: `${VIEW_ROUTE.params}: ${errorMessage(err)}` }
  }
}

/**
 * The node-detail payloads, parsed at the boundary. The node view returns a different shape per
 * node kind and the browser must not guess: each shape is pinned here, and each carries the node
 * `type` it answers for — the discriminant of the union at the bottom of this section.
 */
const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUSD: z.number().nullable(),
  estimated: z.boolean().optional(),
})

export const TaskDetail = z.object({
  type: z.literal(NODE_KIND.task),
  task: z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    title: z.string(),
    spec: z.string().optional(),
    status: z.string(),
    zone: z.array(z.string()).optional(),
    budgetUSD: z.number().nullable().optional(),
    depth: z.number().optional(),
    createdAt: z.string().optional(),
  }),
  usage: Usage.nullish(),
  steps: z
    .array(
      z.object({
        stepId: z.string(),
        status: z.string(),
        attempt: z.number().optional(),
        iterations: z.number().optional(),
        usage: Usage.optional(),
        failure: z.object({ class: z.string().optional(), message: z.string() }).nullable().optional(),
      }),
    )
    .default([]),
  artifacts: z.array(z.object({ path: z.string(), size: z.number().optional() })).default([]),
})
export type TaskDetail = z.infer<typeof TaskDetail>

export const StepDetail = z.object({
  type: z.literal(NODE_KIND.step),
  step: z.object({
    id: z.string(),
    role: z.string().optional(),
    title: z.string(),
    instructions: z.string().optional(),
    modelRef: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    zone: z.array(z.string()).optional(),
  }),
  // null, not absent, until the step runs — and the same for its usage
  run: z
    .object({
      status: z.string(),
      attempt: z.number().optional(),
      iterations: z.number().optional(),
      output: z.string().nullish(),
      failure: z.object({ class: z.string().optional(), message: z.string() }).nullish(),
    })
    .nullish(),
  usage: Usage.nullish(),
})
export type StepDetail = z.infer<typeof StepDetail>

// the artifact record arrives BARE (not wrapped), sized as `size`, and carries no taskId —
// that lives in the node id. Expecting a wrapper made every artifact render as a raw record.
export const ArtifactDetail = z.object({
  type: z.literal(NODE_KIND.artifact),
  path: z.string(),
  size: z.number().optional(),
  sha256: z.string().optional(),
  // `stepId: null` when nothing produced it inside a step; a string-only schema rejects the record
  stepId: z.string().nullish(),
  seq: z.number().optional(),
})
export type ArtifactDetail = z.infer<typeof ArtifactDetail>

// `ref` and `totals` sit at the root and each task carries its own usage — the previous shape
// parsed (every field optional) and rendered a bare list with none of the measured spend.
export const ModelDetail = z.object({
  type: z.literal(NODE_KIND.model),
  ref: z.string(),
  totals: Usage.nullish(),
  tasks: z
    .array(z.object({ taskId: z.string(), title: z.string().optional(), status: z.string().optional(), calls: z.number().optional(), usage: Usage.nullish() }))
    .default([]),
})
export type ModelDetail = z.infer<typeof ModelDetail>

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
    // The chat this row belongs to (null = no chat) and the door that appended it. Both come off
    // the envelope: a row without them cannot be placed in a conversation, which is what the chat
    // scope reads and what tells an operator whether a line came from the web, the CLI or a run.
    chatId: z.string().nullable(),
    door: z.enum(Door),
    // The task that AUTHORED a project-scoped (envelope taskId null) knowledge row, read from
    // payload.author.taskId; null for every other kind and for an ownerless (cli/human) row.
    authorTaskId: z.string().nullable(),
    // Whether the tool call this row summarizes FAILED, and why. The summary line folds isError
    // into display text, so a pane reading rows alone could not tell a refusal from a success —
    // eight consecutive rejected approvals rendered as eight near-identical questions. Set only by
    // a sender holding the raw event beside the row.
    failure: z.object({ toolName: z.string(), error: z.string() }).nullable().optional(),
    // The whole exchange on a copilot_exchange row: the chat pane rebuilds real bubbles from the
    // log rather than from browser storage. A side channel — every other reader renders `line` and
    // ignores this.
    exchange: CopilotExchange.nullable().optional(),
  }),
)
export const LogRow = LogRows.element

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
export const TranscriptItem = Transcript.element

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

const PlanNoteOnWire = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().default(''),
  body: z.string().default(''),
  rationale: z.string().default(''),
  uncertainty: z.array(z.string()).default([]),
  subplans: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  zone: z.array(z.string()).default([]),
  modelRef: z.string().optional(),
  skillRefs: z.array(z.string()).default([]),
  toolRefs: z.array(z.string()).default([]),
})
// a PlanNote field the wire does not name is one no reader can see; this line names it at build time
type UnwiredPlanNoteField = Exclude<keyof PlanNote, keyof z.output<typeof PlanNoteOnWire>>
const WIRE_COVERS_PLAN_NOTE: [UnwiredPlanNoteField] extends [never] ? true : UnwiredPlanNoteField = true
void WIRE_COVERS_PLAN_NOTE

export const PlanNotesView = z.object({ notes: z.array(PlanNoteOnWire) })

/** the models catalog is a BARE array of refs — the `{refs}` wrapper it never had cost a flow */
export const ModelRefs = z.array(z.string())

/**
 * The node view answers with a different shape per node kind, and says WHICH in `type` — the node's
 * own kind, so the answer and the graph node it is about carry one vocabulary.
 *
 * Discriminated, not a plain union with a permissive tail. A trailing `z.record(string, unknown)`
 * accepted every object: the reader never had to be right about a shape, and on the producing side
 * `ViewResult<'node'>` accepted `{ nonsense: 1 }` and a task detail missing every field but `id`.
 * So the guarantee the view interface exists for — a read that stops matching the wire fails the
 * BUILD — did not hold for the one view answering a shape per node kind. With the discriminant,
 * each kind is checked against its own member, on both sides.
 */
export const NodeDetail = z.discriminatedUnion('type', [TaskDetail, StepDetail, ArtifactDetail, ModelDetail])
// A node kind added to NODE_TYPES with no detail schema fails HERE rather than at the pane, where
// it would arrive as an unparseable answer nothing knows how to render.
export type NodeDetailCoversTypes = Exclude<NodeType, z.infer<typeof NodeDetail>['type']> extends never ? true : never
const _detailCovers: NodeDetailCoversTypes = true
void _detailCovers

export const OpenQuestion = z.object({ taskId: z.string(), topic: z.string(), stepId: z.string().nullable(), question: z.string(), seq: z.number() })
export type OpenQuestion = z.infer<typeof OpenQuestion>
export const OperatorState = z.object({ openQuestions: z.array(OpenQuestion), retryable: z.array(z.string()), planned: z.array(z.string()) })
export type OperatorState = z.infer<typeof OperatorState>

// every view answers inside this: `seq` is what lets a client order a refetch against a stream frame
export const ViewEnvelope = <R extends z.ZodType>(data: R) => z.object({ seq: z.number(), data })

// EventKind from '@orc/contracts/event-kinds'. No lower bound on purpose: an EMPTY list means NO
// filter — that is what the timeline's read does with one, and what a caller assembling a kind set
// from an empty selection means by it. A `.min(1)` here made the schema the only part of the stack
// calling that an error, and would have rejected calls the MCP door has always answered.
const Kinds = z.array(z.enum(EventKind))
// A seq cursor is a whole, non-negative event number — a fractional or negative one names no row.
// Both cursors are EXCLUSIVE, which is what lets a reader page in either direction without
// re-reading the row it already holds.
const Seq = z.number().int().nonnegative()

/**
 * Params travel under the names the rest of the codebase already uses for these things — `taskId`,
 * `sinceSeq`, `beforeSeq`, `stepId` — not a shorter query-string spelling: params reach a view as
 * one JSON value (see `viewPath`/`viewParams` above), so there is no URL-length reason to
 * abbreviate them, and a second, shorter vocabulary here would buy nothing but a rename to keep in
 * sync at every call site. `node` keeps `id` because a graph node id is not a task id.
 */
export const WIRE = {
  // `scope` is REQUIRED: a read of the log is a read of some scope, and the caller is the only
  // side that knows which. There is no taskId beside it — two ways to name the same subject is how
  // a door starts answering one of them.
  [VIEW.timeline]: { params: z.object({ scope: Scope, kinds: Kinds.optional(), sinceSeq: Seq.optional(), beforeSeq: Seq.optional(), limit: z.number().int().positive().max(1000).optional() }), result: z.array(LogRow) },
  [VIEW.chats]: { params: z.object({ scope: Scope }), result: z.array(ChatDigest) },
  [VIEW.node]: { params: z.object({ id: z.string().min(1) }), result: NodeDetail },
  [VIEW.transcript]: { params: z.object({ taskId: z.string().min(1), stepId: z.string().optional() }), result: z.array(TranscriptItem) },
  [VIEW.plans]: { params: z.object({ taskId: z.string().min(1) }), result: PlansView },
  [VIEW.planNotes]: { params: z.object({ taskId: z.string().min(1) }), result: PlanNotesView },
  [VIEW.models]: { params: z.object({}), result: ModelRefs },
  [VIEW.operatorState]: { params: z.object({}), result: OperatorState },
} as const satisfies Record<ViewName, { params: z.ZodType; result: z.ZodType }>

// ---- the live stream ----

// The graph shapes graph-wire.ts declares as interfaces, as the schemas that parse them. The two
// cannot be one declaration — graph-wire takes no imports, so the browser can have it without the
// projection's dependencies. What keeps them equal is a pair of assignability guards in the app
// that consumes both (graph-ui/web/src/lib/api/types.ts), where `exactOptionalPropertyTypes` is on.
const GraphNode = z.object({
  id: z.string(),
  type: z.enum(NODE_TYPES),
  label: z.string(),
  detail: z.string(),
  workspaceId: z.string().optional(),
})
const GraphLink = z.object({ source: z.string(), target: z.string(), type: z.string() })

export const GraphSnapshot = z.object({ seq: z.number(), nodes: z.array(GraphNode), links: z.array(GraphLink) })

const GraphPatch = z.object({
  addNodes: z.array(GraphNode).default([]),
  updateNodes: z.array(GraphNode).default([]),
  removeNodeIds: z.array(z.string()).default([]),
  addLinks: z.array(GraphLink).default([]),
  removeLinks: z.array(GraphLink).default([]),
})

/** the chats list, as the sidebar reads it: `name`/`dir` are null until that project is opened */
export const ProjectList = z.array(z.object({ id: z.string(), name: z.string().nullable(), dir: z.string().nullable().optional() }))

/**
 * One query an appended event left stale, named by whatever holds it — a view, or a read that is
 * not one (see TouchableName). `params` is the PATTERN, not necessarily a whole param set: a client
 * refetches the queries it holds that match it.
 */
export const Touch = z.object({ name: TouchableName, params: z.record(z.string(), z.unknown()) })
export type Touch = z.infer<typeof Touch>

/**
 * An SSE frame. This carries the whole live experience — a malformed one used to be cast, so a
 * server-side rename would have corrupted the graph store silently rather than failing. Rejected
 * frames are dropped and reported, never applied half-parsed.
 *
 * `touched` and `operator` default rather than being required because the frames that carry neither
 * are real frames: the chats-list push and the connect-time catch-up say nothing about an event.
 */
export const Envelope = z.object({
  patch: GraphPatch.nullable().optional(),
  summary: LogRow.nullable().optional(),
  projects: ProjectList.optional(),
  touched: z.array(Touch).default([]),
  // The pushed operator value, or null for "unchanged since the last frame THIS connection was
  // sent" — a client holds the last non-null one. Pushed rather than touched because it changes on
  // almost every append and a refetch per event would be a round trip for a value already beside
  // the frame.
  operator: OperatorState.nullable().default(null),
})

/**
 * What a PRODUCER hands the frame schema — the defaulted fields may be omitted, which the inferred
 * (output) type would demand. The sender is typed against this so a frame whose field the parser
 * would reject fails the BUILD, rather than reaching a browser that drops the frame at runtime and
 * reports it in a console nobody is reading.
 */
export type StreamFrame = z.input<typeof Envelope>

// ---- the copilot stream ----

export enum CopilotFrameType {
  text = 'text',
  toolCall = 'tool-call',
  toolResult = 'tool-result',
  toolError = 'tool-error',
  error = 'error',
  done = 'done',
  chat = 'chat',
}

export const CopilotPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal(CopilotFrameType.text), text: z.string() }),
  z.object({ type: z.literal(CopilotFrameType.toolCall), toolName: z.string(), input: z.unknown() }),
  z.object({ type: z.literal(CopilotFrameType.toolResult), toolName: z.string(), output: z.unknown() }),
  z.object({ type: z.literal(CopilotFrameType.toolError), toolName: z.string(), error: z.string() }),
  z.object({ type: z.literal(CopilotFrameType.error), message: z.string() }),
  z.object({
    type: z.literal(CopilotFrameType.done),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUSD: z.number().nullable() }),
  }),
  // sent only after the exchange is committed
  z.object({ type: z.literal(CopilotFrameType.chat), chatId: z.string().min(1) }),
])
export type CopilotPart = z.infer<typeof CopilotPart>
export type CopilotFrame = z.input<typeof CopilotPart>

// fails the build when a frame type has no schema member
export type CopilotPartCoversFrames = Exclude<CopilotFrameType, CopilotPart['type']> extends never ? true : never
const _framesCovered: CopilotPartCoversFrames = true
void _framesCovered
