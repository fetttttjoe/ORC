// E2E fixture server (run by playwright's webServer): real Postgres test db, seeded state,
// scripted copilot, kernel-backed newTask — everything else read-only-stubbed.
import { MockLanguageModelV4 } from 'ai/test'
import { draftFixture } from '@orc/contracts/fixtures'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import type { OrcActions } from '@orc/ui-core'
import { startGraphUi } from '../src/server'

export const E2E_PORT = 7911

const db = await createTestDb()
const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
const kernel = new Kernel(storage.events)
const seeded = await kernel.createTask({ title: 'hello world request', spec: 'write hello.txt' })
await kernel.proposePlan(seeded.id, draftFixture())

const copilotModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: new ReadableStream({
      start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] })
        c.enqueue({ type: 'text-start', id: '1' })
        c.enqueue({ type: 'text-delta', id: '1', delta: 'e2e copilot reply' })
        c.enqueue({ type: 'text-end', id: '1' })
        c.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: undefined, reasoning: undefined },
          },
        })
        c.close()
      },
    }),
  }),
})

const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not available in e2e fixture`) }
const actions: OrcActions = {
  newTask: async input => ({ taskId: (await kernel.createTask({ title: input.title, spec: input.spec ?? '' })).id }),
  propose: unsupported('propose'),
  edit: unsupported('edit'),
  approve: async taskId => ({ version: (await kernel.approvePlan(taskId)).version }),
  run: unsupported('run'),
  reply: unsupported('reply'),
  retry: unsupported('retry'),
  cancel: unsupported('cancel'),
  annotate: unsupported('annotate'),
  revise: unsupported('revise'),
}

startGraphUi({
  url: db.url,
  port: E2E_PORT,
  cwdProject: { id: TEST_PROJECT_ID, name: 'e2e-project' },
  actions,
  copilot: { resolveModel: () => copilotModel, defaultModelRef: 'mock/e2e', price: () => 0.0001 },
  defaultCwd: '/tmp',
})
console.log(`e2e server on http://127.0.0.1:${E2E_PORT}`)
