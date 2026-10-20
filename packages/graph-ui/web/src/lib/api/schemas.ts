import { z } from 'zod'
// Health vocabulary comes from contracts: a re-typed enum accepts states the server stopped sending
import { KnowledgeHealth, SupervisorHealthState } from '@orc/contracts/health'
import { MessageRole } from '@orc/contracts/chat'
// the view registry and parsed shapes come from ui-core's browser-safe wire module
import {
  ArtifactDetail, Envelope, GraphSnapshot, LogRows, ModelDetail, ModelRefs,
  PlanNotesView, PlansView, ProjectList, StepDetail, TaskDetail, Transcript,
  VIEW, VIEW_ROUTE, ViewEnvelope, viewPath,
} from '@orc/ui-core/wire'

// re-exported so the contract test and components import from this one file
export {
  ArtifactDetail, Envelope, GraphSnapshot, LogRows, ModelDetail, ModelRefs,
  PlanNotesView, PlansView, ProjectList, StepDetail, TaskDetail, Transcript,
  VIEW, VIEW_ROUTE, ViewEnvelope, viewPath,
}

// Response shapes as data, not type assertions: a renamed field fails loudly, naming the path

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
  supervisor: z.object({ state: z.enum(SupervisorHealthState), pid: z.number().optional(), lastSeenAt: z.string().optional() }).optional(),
})

// Only shapes a caller reads are pinned; an ignored result stays unknown
export const TaskCreated = z.object({ taskId: z.string().min(1) })
export const ReplyResult = z.object({ answered: z.boolean(), supervised: z.boolean() })
export const ApprovedVersion = z.object({ version: z.number() })
/** purge/delete report what they removed and anything they could not */
export const PurgeReport = z.object({ events: z.number().optional(), operations: z.number().optional(), warnings: z.array(z.string()).default([]) })

// persisted client state: localStorage history is untrusted input like any other wire
export const StoredChat = z.array(z.object({ role: z.enum(MessageRole), content: z.string() }))
