import { sql } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import type { Door, EventKind, OperationKind, OperationStatus, Usage } from '@orc/contracts'

export const events = pgTable(
  'events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: text('project_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    chatId: text('chat_id'),
    // never null: an anonymous event cannot be traced to a CLI, MCP or hook door
    door: text('door').$type<Door>().notNull(),
    taskId: text('task_id'),
    stepId: text('step_id'),
    runToken: text('run_token'),
    kind: text('kind').$type<EventKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    usage: jsonb('usage').$type<Usage>(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  t => [
    index('idx_events_project_seq').on(t.projectId, t.seq),
    index('idx_events_project_task_seq').on(t.projectId, t.taskId, t.seq),
    index('idx_events_project_chat_seq').on(t.projectId, t.chatId, t.seq),
    index('idx_events_project_kind_seq').on(t.projectId, t.kind, t.seq),
    uniqueIndex('uq_events_project_idempotency')
      .on(t.projectId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
)

export const operations = pgTable(
  'operations',
  {
    projectId: text('project_id').notNull(),
    operationId: text('operation_id').notNull(),
    taskId: text('task_id').notNull(),
    stepId: text('step_id').notNull(),
    runToken: text('run_token').notNull(),
    kind: text('kind').$type<OperationKind>().notNull(),
    name: text('name').notNull(),
    status: text('status').$type<OperationStatus>().notNull(),
    attempts: integer('attempts').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    error: jsonb('error'),
    startedSeq: bigint('started_seq', { mode: 'number' }).notNull(),
    finishedSeq: bigint('finished_seq', { mode: 'number' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  t => [
    primaryKey({ columns: [t.projectId, t.operationId] }),
    index('idx_operations_project_task_started').on(t.projectId, t.taskId, t.startedSeq),
    index('idx_operations_project_run_started').on(t.projectId, t.runToken, t.startedSeq),
  ],
)

export const supervisors = pgTable(
  'supervisors',
  {
    projectId: text('project_id').notNull(),
    executorId: text('executor_id').notNull(),
    pid: integer('pid').notNull(),
    host: text('host').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  t => [primaryKey({ columns: [t.projectId, t.executorId] })],
)
