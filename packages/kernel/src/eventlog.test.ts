import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EventInput } from '@orc/contracts'
import { EventLog } from './eventlog'

const freshDbPath = () => path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')

const statusEvent = (taskId = 't1'): EventInput => ({
  taskId, stepId: null, runToken: null,
  kind: 'task_status_changed',
  payload: { taskId, from: 'draft', to: 'awaiting_approval' },
})

describe('EventLog', () => {
  it('appends with monotonic seq and a timestamp', () => {
    const log = new EventLog(freshDbPath())
    const a = log.append(statusEvent())
    const b = log.append(statusEvent())
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
  it('rejects payloads that do not match the kind schema', () => {
    const log = new EventLog(freshDbPath())
    expect(() =>
      log.append({ ...statusEvent(), payload: { wrong: true } }),
    ).toThrow()
    expect(log.all()).toHaveLength(0)
  })
  it('filters by task and orders by seq', () => {
    const log = new EventLog(freshDbPath())
    log.append(statusEvent('t1'))
    log.append(statusEvent('t2'))
    log.append(statusEvent('t1'))
    expect(log.byTask('t1').map(e => e.seq)).toEqual([1, 3])
  })
  it('persists across reopen (migrations are idempotent)', () => {
    const p = freshDbPath()
    const log = new EventLog(p)
    log.append(statusEvent())
    log.close()
    const reopened = new EventLog(p)
    expect(reopened.all()).toHaveLength(1)
  })
})
