import { and, asc, eq } from 'drizzle-orm'
import {
  EVENT_KIND, OPERATION_STATUS, terminalError,
  type EventDraft, type OperationRecord, type OperationSpec,
} from '@orc/contracts'
import { operations } from '../schema'
import { applyOperationEvent, foldOperations } from '../projections'
import { PostgresStore, type Tx } from './postgres'
import type { EventLog } from './event-log'

type OperationRow = typeof operations.$inferSelect

const toOperation = (r: OperationRow): OperationRecord => ({
  projectId: r.projectId,
  operationId: r.operationId,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  name: r.name,
  status: r.status,
  attempts: r.attempts,
  before: r.before,
  after: r.after,
  error: r.error,
  startedSeq: r.startedSeq,
  finishedSeq: r.finishedSeq,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
})

const toOperationRow = (o: OperationRecord) => ({
  ...o,
  startedAt: new Date(o.startedAt),
  finishedAt: o.finishedAt === null ? null : new Date(o.finishedAt),
})

export interface OperationContext {
  taskId: string
  stepId: string
  runToken: string
}

// Durable before/after journal (design §5.2): node and transition events commit in one
// locked transaction, so the graph node and the append-only history can never disagree.
export class OperationJournal {
  constructor(private readonly store: PostgresStore, private readonly events: EventLog) {}

  private async row(tx: Tx, operationId: string): Promise<OperationRow | undefined> {
    const [row] = await tx.select().from(operations)
      .where(and(eq(operations.projectId, this.store.projectId), eq(operations.operationId, operationId)))
    return row
  }

  private async upsert(tx: Tx, rec: OperationRecord): Promise<void> {
    await tx.insert(operations).values(toOperationRow(rec))
      .onConflictDoUpdate({ target: [operations.projectId, operations.operationId], set: toOperationRow(rec) })
  }

  // commits the before-record ahead of the external effect; completed nodes are reused,
  // started/failed nodes begin the next attempt (explicitly at-least-once)
  beginOperation(
    context: OperationContext,
    spec: OperationSpec,
  ): Promise<{ reused: boolean; attempt: number; value?: unknown }> {
    return this.store.withProjectLock(async tx => {
      const ops = this.events.txOps(tx)
      const existing = await this.row(tx, spec.operationId)
      if (existing?.status === OPERATION_STATUS.completed)
        return { reused: true, attempt: existing.attempts, value: existing.after }
      const attempt = (existing?.attempts ?? 0) + 1
      const event = await ops.append({
        taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
        kind: EVENT_KIND.operation_started,
        payload: { operationId: spec.operationId, attempt, operationKind: spec.kind, name: spec.name, before: spec.before },
        idempotencyKey: `${spec.operationId}:${attempt}:started`,
      })
      await this.upsert(tx, applyOperationEvent(undefined, event))
      return { reused: false, attempt }
    })
  }

  // idempotent re-entry for a committed attempt; stale attempts throw TERMINAL so the
  // durable-step wrapper never re-fires the effect over a newer attempt
  completeOperation(
    context: OperationContext,
    spec: OperationSpec,
    attempt: number,
    value: unknown,
    drafts: EventDraft[] = [],
  ): Promise<unknown> {
    return this.store.withProjectLock(async tx => {
      const ops = this.events.txOps(tx)
      const existing = await this.row(tx, spec.operationId)
      if (!existing) throw terminalError(`operation '${spec.operationId}' was never started`)
      if (existing.status === OPERATION_STATUS.completed) {
        if (existing.attempts === attempt) return existing.after // lost-ack re-entry: already durable
        throw terminalError(`operation '${spec.operationId}' already completed at attempt ${existing.attempts}`)
      }
      if (existing.attempts !== attempt)
        throw terminalError(`operation '${spec.operationId}' attempt ${attempt} is stale (current attempt is ${existing.attempts})`)
      const event = await ops.append({
        taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
        kind: EVENT_KIND.operation_completed,
        payload: { operationId: spec.operationId, attempt, after: value },
        idempotencyKey: `${spec.operationId}:${attempt}:completed`,
      })
      const next = applyOperationEvent(toOperation(existing), event)
      await this.upsert(tx, next)
      for (const [i, d] of drafts.entries())
        await ops.append({
          taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
          kind: d.kind, payload: d.payload, usage: d.usage ?? null,
          idempotencyKey: d.idempotencyKey ?? `${spec.operationId}:${attempt}:draft:${i}`,
        })
      return next.after
    })
  }

  // no-op on ambiguity (runs from catch paths whose error must surface); a COMPLETED
  // node is never regressed by a lost commit-ack
  failOperation(context: OperationContext, spec: OperationSpec, attempt: number, error: unknown): Promise<void> {
    return this.store.withProjectLock(async tx => {
      const ops = this.events.txOps(tx)
      const existing = await this.row(tx, spec.operationId)
      if (!existing) throw terminalError(`operation '${spec.operationId}' was never started`)
      if (existing.status === OPERATION_STATUS.completed || existing.attempts !== attempt) return
      const event = await ops.append({
        taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
        kind: EVENT_KIND.operation_failed,
        payload: { operationId: spec.operationId, attempt, error },
        idempotencyKey: `${spec.operationId}:${attempt}:failed`,
      })
      await this.upsert(tx, applyOperationEvent(toOperation(existing), event))
    })
  }

  async operationsFor(taskId: string): Promise<OperationRecord[]> {
    const rows = await this.store.db.select().from(operations)
      .where(and(eq(operations.projectId, this.store.projectId), eq(operations.taskId, taskId)))
      .orderBy(asc(operations.startedSeq))
    return rows.map(toOperation)
  }

  // the journal is an index over the append-only truth — rebuildable per project
  rebuildOperations(): Promise<number> {
    return this.store.withProjectLock(async tx => {
      const transitions = await this.events.txOps(tx).after(0, [
        EVENT_KIND.operation_started, EVENT_KIND.operation_completed, EVENT_KIND.operation_failed,
      ])
      const folded = foldOperations(transitions)
      await tx.delete(operations).where(eq(operations.projectId, this.store.projectId))
      const rows = [...folded.values()].map(toOperationRow)
      if (rows.length > 0) await tx.insert(operations).values(rows)
      return folded.size
    })
  }
}
