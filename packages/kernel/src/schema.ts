import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { EventKind } from '@orc/contracts'

export const events = pgTable(
  'events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: text('task_id'),
    stepId: text('step_id'),
    runToken: text('run_token'),
    kind: text('kind').$type<EventKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  t => [index('idx_events_task').on(t.taskId)],
)
