import { z } from 'zod'
// a leaf (zod plus a type-only import): the browser takes it without the rest of contracts
import { EventKind } from '@orc/contracts/event-kinds'
// guards.ts is a leaf too (zod only) — one spelling of error→string, browser bundle included
import { errorMessage } from '@orc/contracts/guards'
// the same schemas the derivations parse: a second spelling is a shape no view could answer
import { Scope } from '@orc/contracts/scope'
import { ChatDigest } from '@orc/contracts/chat-digest'
import { Door } from '@orc/contracts/origin'
import type { PlanNote } from '@orc/contracts/plan-note'
import { NODE_TYPES, type NodeType } from './graph-wire'

// derived from NODE_TYPES: the answer's kind is the node's own type
export const NODE_KIND = z.enum(NODE_TYPES).enum

// keyed by VIEW, satisfies Record<ViewName, ...>: a view without params and result fails the build
export const ViewName = z.enum(['timeline', 'chats', 'node', 'transcript', 'plans', 'planNotes', 'models', 'operatorState'])
export type ViewName = z.infer<typeof ViewName>
export const VIEW = ViewName.enum

// every name a stream frame can report as stale, derived from ViewName's options
export const TouchableName = z.enum(ViewName.options)
export type TouchableName = z.infer<typeof TouchableName>
export const TOUCHABLE = TouchableName.enum

// params travel as one url-encoded JSON value: they are typed objects, not flat query keys
export const VIEW_ROUTE = { prefix: '/api/view/', params: 'q' } as const

// the project a project-scoped GET names: one spelling for every door
export const PROJECT_PARAM = 'project'

// project is required: it decides the ? or & join; absent params mean no q at all
export const viewPath = (name: string, project: string, params?: unknown): string =>
  `${VIEW_ROUTE.prefix}${name}?${PROJECT_PARAM}=${encodeURIComponent(project)}`
  + (params === undefined ? '' : `&${VIEW_ROUTE.params}=${encodeURIComponent(JSON.stringify(params))}`)

// mirror of viewPath: absent q is no params; malformed JSON returns a failure for a 400
export const viewParams = (q: string | null): { ok: true; params: unknown } | { ok: false; error: string } => {
  if (q === null) return { ok: true, params: {} }
  try {
    return { ok: true, params: JSON.parse(q) }
  } catch (err) {
    return { ok: false, error: `${VIEW_ROUTE.params}: ${errorMessage(err)}` }
  }
}

// node-detail payloads parsed at the boundary, each carrying the node type it answers for
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

// the artifact record arrives bare (not wrapped), as size, with no taskId (it is in the node id)
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

// ref and totals sit at the root and each task carries its own usage
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
    // chat and door come off the envelope: without them a row cannot be placed in a conversation
    chatId: z.string().nullable(),
    door: z.enum(Door),
    // the task that authored a project-scoped knowledge row, from payload.author.taskId
    authorTaskId: z.string().nullable(),
    // set only by a sender holding the raw event: the summary line folds isError into text
    failure: z.object({ toolName: z.string(), error: z.string() }).nullable().optional(),
    // the whole exchange on a copilot_exchange row: a side channel the chat pane rebuilds bubbles from
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
      // keeps every field PlanDraft requires: reopening a plan posts these steps back
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
// a PlanNote field the wire does not name is invisible to readers; this fails the build
type UnwiredPlanNoteField = Exclude<keyof PlanNote, keyof z.output<typeof PlanNoteOnWire>>
const WIRE_COVERS_PLAN_NOTE: [UnwiredPlanNoteField] extends [never] ? true : UnwiredPlanNoteField = true
void WIRE_COVERS_PLAN_NOTE

export const PlanNotesView = z.object({ notes: z.array(PlanNoteOnWire) })

// the models catalog is a bare array of refs, not a {refs} wrapper
export const ModelRefs = z.array(z.string())

// discriminated, not a permissive union: each kind is checked against its own member on both sides
export const NodeDetail = z.discriminatedUnion('type', [TaskDetail, StepDetail, ArtifactDetail, ModelDetail])
// a node kind with no detail schema fails here rather than at the pane
export type NodeDetailCoversTypes = Exclude<NodeType, z.infer<typeof NodeDetail>['type']> extends never ? true : never
const _detailCovers: NodeDetailCoversTypes = true
void _detailCovers

export const OpenQuestion = z.object({ taskId: z.string(), topic: z.string(), stepId: z.string().nullable(), question: z.string(), seq: z.number() })
export type OpenQuestion = z.infer<typeof OpenQuestion>
export const OperatorState = z.object({ openQuestions: z.array(OpenQuestion), retryable: z.array(z.string()), planned: z.array(z.string()) })
export type OperatorState = z.infer<typeof OperatorState>

// every view answers inside this: seq orders a refetch against a stream frame
export const ViewEnvelope = <R extends z.ZodType>(data: R) => z.object({ seq: z.number(), data })

// an empty list means no filter, as the timeline read and the MCP door already treat it
const Kinds = z.array(z.enum(EventKind))
// cursors are exclusive whole non-negative event numbers, so a reader can page either way
const Seq = z.number().int().nonnegative()

// params use the codebase's names; node keeps id because a graph node id is not a task id
export const WIRE = {
  // scope is required: the caller alone knows which; no taskId beside it, two names for one subject
  [VIEW.timeline]: { params: z.object({ scope: Scope, kinds: Kinds.optional(), sinceSeq: Seq.optional(), beforeSeq: Seq.optional(), limit: z.number().int().positive().max(1000).optional() }), result: z.array(LogRow) },
  [VIEW.chats]: { params: z.object({ scope: Scope }), result: z.array(ChatDigest) },
  [VIEW.node]: { params: z.object({ id: z.string().min(1) }), result: NodeDetail },
  [VIEW.transcript]: { params: z.object({ taskId: z.string().min(1), stepId: z.string().optional() }), result: z.array(TranscriptItem) },
  [VIEW.plans]: { params: z.object({ taskId: z.string().min(1) }), result: PlansView },
  [VIEW.planNotes]: { params: z.object({ taskId: z.string().min(1) }), result: PlanNotesView },
  [VIEW.models]: { params: z.object({}), result: ModelRefs },
  [VIEW.operatorState]: { params: z.object({}), result: OperatorState },
} as const satisfies Record<ViewName, { params: z.ZodType; result: z.ZodType }>


// parses graph-wire's interfaces; assignability guards in graph-ui's types.ts keep them equal
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

// the sidebar's chats list: name and dir are null until the project is opened
export const ProjectList = z.array(z.object({ id: z.string(), name: z.string().nullable(), dir: z.string().nullable().optional() }))

// params is a pattern: a client refetches the queries it holds that match it
export const Touch = z.object({ name: TouchableName, params: z.record(z.string(), z.unknown()) })
export type Touch = z.infer<typeof Touch>

// rejected frames are dropped and reported, never applied half-parsed
export const Envelope = z.object({
  patch: GraphPatch.nullable().optional(),
  summary: LogRow.nullable().optional(),
  projects: ProjectList.optional(),
  touched: z.array(Touch).default([]),
  // null = unchanged since the last frame on this connection; pushed because it changes per event
  operator: OperatorState.nullable().default(null),
})

// the producer's type: a frame the parser would reject fails the build
export type StreamFrame = z.input<typeof Envelope>


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
