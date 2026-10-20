import { and, asc, eq } from 'drizzle-orm'
import {
  EVENT_KIND, OperationStatus, terminalError,
  type EventDraft, type OperationRecord, type OperationSpec, type Origin,
} from '@orc/contracts'
import { operations } from '../schema'
import { applyOperationEvent, foldOperations } from '../projections'
import { PostgresStore, type Tx } from './postgres'
import type { EventLog } from './event-log'

type OperationRow = typeof operations.$inferSelect

const toOperation = (r: OperationRow): OperationRecord => ({
  ...r,
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
  origin: Origin
}

// one spelling: a per-append literal drops the chat and door on whichever path is edited last
const envelopeOf = (context: OperationContext) => ({
  ...context.origin,
  taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
})

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

  // before-record commits ahead of the external effect; completed nodes are reused
  beginOperation(
    context: OperationContext,
    spec: OperationSpec,
  ): Promise<{ reused: boolean; attempt: number; value?: unknown }> {
    return this.store.withProjectLock(async tx => {
      const ops = this.events.txOps(tx)
      const existing = await this.row(tx, spec.operationId)
      if (existing?.status === OperationStatus.completed)
        return { reused: true, attempt: existing.attempts, value: existing.after }
      const attempt = (existing?.attempts ?? 0) + 1
      const event = await ops.append({
        ...envelopeOf(context),
        kind: EVENT_KIND.operation_started,
        payload: { operationId: spec.operationId, attempt, operationKind: spec.kind, name: spec.name, before: spec.before },
        idempotencyKey: `${spec.operationId}:${attempt}:started`,
      })
      await this.upsert(tx, applyOperationEvent(undefined, event))
      return { reused: false, attempt }
    })
  }

  // stale attempts throw TERMINAL so the step wrapper never re-fires over a newer attempt
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
      if (existing.status === OperationStatus.completed) {
        if (existing.attempts === attempt) return existing.after // lost-ack re-entry: already durable
        throw terminalError(`operation '${spec.operationId}' already completed at attempt ${existing.attempts}`)
      }
      if (existing.attempts !== attempt)
        throw terminalError(`operation '${spec.operationId}' attempt ${attempt} is stale (current attempt is ${existing.attempts})`)
      const event = await ops.append({
        ...envelopeOf(context),
        kind: EVENT_KIND.operation_completed,
        payload: { operationId: spec.operationId, attempt, after: value },
        idempotencyKey: `${spec.operationId}:${attempt}:completed`,
      })
      const next = applyOperationEvent(toOperation(existing), event)
      await this.upsert(tx, next)
      for (const [i, d] of drafts.entries())
        await ops.append({
          ...envelopeOf(context), ...d, usage: d.usage ?? null,
          idempotencyKey: d.idempotencyKey ?? `${spec.operationId}:${attempt}:draft:${i}`,
        })
      return next.after
    })
  }

  // no-op on ambiguity (catch paths must surface their error); a COMPLETED node never regresses
  failOperation(context: OperationContext, spec: OperationSpec, attempt: number, error: unknown): Promise<void> {
    return this.store.withProjectLock(async tx => {
      const ops = this.events.txOps(tx)
      const existing = await this.row(tx, spec.operationId)
      if (!existing) throw terminalError(`operation '${spec.operationId}' was never started`)
      if (existing.status === OperationStatus.completed || existing.attempts !== attempt) return
      const event = await ops.append({
        ...envelopeOf(context),
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
