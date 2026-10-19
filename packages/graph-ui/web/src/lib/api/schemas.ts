import { z } from 'zod'
// the health vocabulary comes from contracts, never a second spelling: health.ts is zero-import
// precisely so the browser can take it, and a re-typed enum here silently accepts a state the
// server stopped sending (or rejects one it started sending)
import { KnowledgeHealth, SUPERVISOR_HEALTH_STATES } from '@orc/contracts/health'
import { MessageRole } from '@orc/contracts/chat'
// the view registry and every parsed response shape come from ui-core's browser-safe wire
// module — the one spelling the server and this app both import
import {
  ArtifactDetail, Envelope, GraphSnapshot, LogRows, ModelDetail, ModelRefs,
  PlanNotesView, PlansView, ProjectList, StepDetail, TaskDetail, Transcript,
  VIEW, VIEW_ROUTE, ViewEnvelope, viewPath,
} from '@orc/ui-core/wire'

// re-exported so the contract test and every component keep importing from this one file.
// NodeDetail/TranscriptItem/LogRow (the SINGULAR element schemas) are not re-exported: every
// consumer of a node or transcript or log-row shape now gets it typed through view-client.ts's
// `ViewResult<N>`, parsed once at the fetch boundary — a schema import here with no reader left.
export {
  ArtifactDetail, Envelope, GraphSnapshot, LogRows, ModelDetail, ModelRefs,
  PlanNotesView, PlansView, ProjectList, StepDetail, TaskDetail, Transcript,
  VIEW, VIEW_ROUTE, ViewEnvelope, viewPath,
}

/**
 * The response shape of every endpoint, as data rather than as a type assertion.
 *
 * A `get<T>()` cast is erased at build time, so a server that renames a field or moves it a level
 * deeper produces an empty render and nothing else — measured on this app: the model picker sat
 * permanently empty (a bare array read as `{refs}`), artifacts fell through to "unrecognised
 * shape", and a model's whole cost lens went blank. Every one of those was invisible until
 * someone looked at the screen.
 *
 * Parsing here turns each of them into ONE loud error naming the endpoint and the field path, and
 * lets e2e/contract.pw.ts assert the live server still satisfies them.
 */

export const SessionInfo = z.object({
  projectId: z.string().nullable(),
  actions: z.boolean(),
  copilot: z.boolean(),
  token: z.string().optional(),
  copilotModel: z.string().nullable().optional(),
  defaultCwd: z.string().nullable().optional(),
  bootedAt: z.string().optional(),
})

export const Health = z.object({
  knowledge: KnowledgeHealth.nullable(),
  supervisor: z.object({ state: z.enum(SUPERVISOR_HEALTH_STATES), pid: z.number().optional(), lastSeenAt: z.string().optional() }).optional(),
})

// ---- action results ----
// Only the shapes a caller actually reads are pinned; an action whose result the UI ignores
// stays unknown rather than inventing a contract nobody depends on.
export const TaskCreated = z.object({ taskId: z.string().min(1) })
export const ReplyResult = z.object({ answered: z.boolean(), supervised: z.boolean() })
export const ApprovedVersion = z.object({ version: z.number() })
/** purge/delete report what they removed and anything they could not */
export const PurgeReport = z.object({ events: z.number().optional(), operations: z.number().optional(), warnings: z.array(z.string()).default([]) })

// ---- persisted client state ----
/** the copilot history in localStorage is untrusted input like any other wire */
export const StoredChat = z.array(z.object({ role: z.enum(MessageRole), content: z.string() }))
