import { afterEach, describe, expect, it } from 'bun:test'
import type { TaskNode } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { createTestDb } from './test-helpers'
import { EventLog } from './eventlog'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop() })

const task = (id: string): TaskNode => ({
  id, parentId: null, type: 'generic', title: id, spec: '', status: 'draft',
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-17T00:00:00.000Z',
})
const appendCreated = (log: EventLog, id: string) =>
  log.append({ taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task(id) } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('EventLog.subscribe', () => {
  it('catches up from fromSeq then pushes new appends in order', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = await EventLog.open(db.url)
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')

    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await sleep(50)
    expect(seen).toEqual([1, 2])              // catch-up

    await appendCreated(log, 'c')
    await sleep(100)
    expect(seen).toEqual([1, 2, 3])           // pushed, no poll

    await unsub()
    await log.close()
  })

  it('delivers nothing for a rolled-back transaction (commit-only)', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = await EventLog.open(db.url)
    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await sleep(30)
    await log.transaction(async tx => { await tx.append({ taskId: 'x', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task('x') } }); throw new Error('rollback') }).catch(() => {})
    await sleep(100)
    expect(seen).toEqual([])
    await unsub()
    await log.close()
  })
})
