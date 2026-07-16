import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { EventKind } from '@orc/contracts'

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    taskId: text('task_id').notNull(),
    stepId: text('step_id'),
    runToken: text('run_token'),
    kind: text('kind').$type<EventKind>().notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    ts: text('ts').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  t => [index('idx_events_task').on(t.taskId)],
)
