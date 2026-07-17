import { afterAll, describe, expect, it } from 'bun:test'
import type { EventInput } from '@orc/contracts'
import { EventLog } from './eventlog'
import { createTestDb } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function freshLog(): Promise<EventLog> {
  const db = await createTestDb()
  dbs.push(db)
  return EventLog.open(db.url)
}

const statusEvent = (taskId = 't1'): EventInput => ({
  taskId, stepId: null, runToken: null,
  kind: 'task_status_changed',
  payload: { taskId, from: 'draft', to: 'awaiting_approval' },
})

describe('EventLog (postgres)', () => {
  it('appends with monotonic seq and ISO timestamp', async () => {
    const log = await freshLog()
    const a = await log.append(statusEvent())
    const b = await log.append(statusEvent())
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await log.close()
  })

  it('rejects payloads that do not match the kind schema', async () => {
    const log = await freshLog()
    await expect(log.append({ ...statusEvent(), payload: { wrong: true } })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })

  it('filters by task and orders by seq', async () => {
    const log = await freshLog()
    await log.append(statusEvent('t1'))
    await log.append(statusEvent('t2'))
    await log.append(statusEvent('t1'))
    expect((await log.byTask('t1')).map(e => e.seq)).toEqual([1, 3])
    expect((await log.byTaskSince('t1', 1)).map(e => e.seq)).toEqual([3])
    await log.close()
  })

  it('strips \\u0000 from payload strings (jsonb cannot store them)', async () => {
    const log = await freshLog()
    const rec = await log.append({
      taskId: 't1', stepId: 's1', runToken: 'r1',
      kind: 'tool_result',
      payload: {
        stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read',
        output: { content: 'binary\u0000data' }, isError: false,
      },
    })
    expect((rec.payload as { output: { content: string } }).output.content).toBe('binarydata')
    const [stored] = await log.byTask('t1')
    expect((stored!.payload as { output: { content: string } }).output.content).toBe('binarydata')
    await log.close()
  })

  it('transaction rolls back atomically on error', async () => {
    const log = await freshLog()
    await expect(
      log.transaction(async tx => {
        await tx.append(statusEvent())
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })

  it('transaction reads see writes made inside the same transaction', async () => {
    const log = await freshLog()
    const count = await log.transaction(async tx => {
      await tx.append(statusEvent())
      return (await tx.all()).length
    })
    expect(count).toBe(1)
    await log.close()
  })

  it('persists across reopen (migrations are idempotent)', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = await EventLog.open(db.url)
    await log.append(statusEvent())
    await log.close()
    const reopened = await EventLog.open(db.url)
    expect(await reopened.all()).toHaveLength(1)
    await reopened.close()
  })
})
