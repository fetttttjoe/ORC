import { z } from 'zod'

// One generic before/after journal covers model and tool effects: a node is created
// (started) before the external call and resolved (completed/failed) after it, so a
// crash can leave an explicit unresolved node but never a blind gap.
export const OperationKind = z.enum(['model', 'tool'])
export type OperationKind = z.infer<typeof OperationKind>
export const OPERATION_KIND = OperationKind.enum

export const OperationStatus = z.enum(['started', 'completed', 'failed'])
export type OperationStatus = z.infer<typeof OperationStatus>
export const OPERATION_STATUS = OperationStatus.enum

export const OperationSpec = z.object({
  operationId: z.string().min(1), // deterministic within the run
  kind: OperationKind,
  name: z.string().min(1), // model ref or tool name
  before: z.unknown(), // redacted request/input
})
export type OperationSpec = z.infer<typeof OperationSpec>

// typed transition payloads — PAYLOAD_SCHEMAS entries and the kernel's journal fold
// parse through these, so payload access never needs a cast
export const OperationStartedPayload = z.object({
  operationId: z.string().min(1),
  attempt: z.number().int().positive(),
  operationKind: OperationKind,
  name: z.string().min(1),
  before: z.unknown(),
})
export type OperationStartedPayload = z.infer<typeof OperationStartedPayload>

export const OperationCompletedPayload = z.object({
  operationId: z.string().min(1),
  attempt: z.number().int().positive(),
  after: z.unknown(),
})
export type OperationCompletedPayload = z.infer<typeof OperationCompletedPayload>

export const OperationFailedPayload = z.object({
  operationId: z.string().min(1),
  attempt: z.number().int().positive(),
  error: z.unknown(),
})
export type OperationFailedPayload = z.infer<typeof OperationFailedPayload>

// the durable current execution graph node (Postgres `operations` row)
export interface OperationRecord {
  projectId: string
  operationId: string
  taskId: string
  stepId: string
  runToken: string
  kind: OperationKind
  name: string
  status: OperationStatus
  attempts: number
  before: unknown
  after: unknown | null
  error: unknown | null
  startedSeq: number
  finishedSeq: number | null
  startedAt: string
  finishedAt: string | null
}
