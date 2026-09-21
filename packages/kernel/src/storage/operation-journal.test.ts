import { afterAll, describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, OperationKind, type OperationSpec } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { openStorage, type Storage } from '../storage'
import { createTestDb, TEST_PROJECT_ID } from '../test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

async function freshStorage(): Promise<Storage> {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  return storage
}

const CONTEXT = {
  taskId: 't1', stepId: 's1', runToken: 'step:t1:s1:a1',
  origin: { chatId: 'c1', door: Door.web },
}
const SPEC: OperationSpec = { operationId: 'step:t1:s1:a1:model:1', kind: OperationKind.model, name: 'fake/m', before: {} }

describe('OperationJournal envelope', () => {
  // the journal appends on four paths; one that spelled its own envelope would drop the chat the
  // operation ran in, and the events would be unattributable to the interaction that caused them
  it('stamps every transition it appends with the context origin', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(CONTEXT, SPEC)
    await journal.completeOperation(CONTEXT, SPEC, 1, { text: 'answer' }, [
      { kind: EVENT_KIND.agent_call, payload: { stepId: 's1', runToken: CONTEXT.runToken, iteration: 1, request: {}, response: {} } },
    ])
    const failing: OperationSpec = { ...SPEC, operationId: 'step:t1:s1:a1:model:2' }
    await journal.beginOperation(CONTEXT, failing)
    await journal.failOperation(CONTEXT, failing, 1, { message: 'boom' })

    const appended = await log.byTask('t1')
    expect(appended.map(e => e.kind)).toEqual([
      EVENT_KIND.operation_started, EVENT_KIND.operation_completed, EVENT_KIND.agent_call,
      EVENT_KIND.operation_started, EVENT_KIND.operation_failed,
    ])
    for (const event of appended) expect([event.kind, event.chatId, event.door])
      .toEqual([event.kind, CONTEXT.origin.chatId, CONTEXT.origin.door])
    expect(must(appended[0], 'the started event').taskId).toBe(CONTEXT.taskId)
  })
})
