import { afterAll, describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, NO_CHAT, ORC_CHAT_ID, WORKSPACE_KIND } from '../../packages/contracts/src/index'
import { Kernel, openStorage } from '../../packages/kernel/src/index'
import { createTestDb, TEST_PROJECT_ID } from '../../packages/kernel/src/test-helpers'
import { appendCommit, hookOrigin } from './post-commit-append'

const dbs: Array<{ drop: () => Promise<void> }> = []
const stores: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  for (const s of stores) await s.close()
  for (const d of dbs) await d.drop()
}, 30_000)

async function setup() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  stores.push(storage)
  // the hook records a commit made in a checkout the fold already knows
  const { workspace } = await new Kernel(storage.events).ensureWorkspace(
    { cwd: process.cwd(), branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, NO_CHAT(Door.cli),
  )
  return { storage, workspaceId: workspace.id }
}

describe('post-commit append', () => {
  it('stamps the running chat and the hook door, and names the cwd workspace', async () => {
    const { storage, workspaceId } = await setup()
    await appendCommit(storage.events, 'a'.repeat(40), 'src/a.ts', { [ORC_CHAT_ID]: 'chat-7' }, process.cwd())
    const recorded = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.commit_recorded)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.chatId).toBe('chat-7')
    expect(recorded[0]?.door).toBe(Door.hook)
    expect(recorded[0]?.payload.workspaceId).toBe(workspaceId)
  })

  it('records no chat when the environment names none', async () => {
    const { storage } = await setup()
    await appendCommit(storage.events, 'b'.repeat(40), '', {}, process.cwd())
    const recorded = (await storage.events.all()).filter(e => e.kind === EVENT_KIND.commit_recorded)
    expect(recorded[0]?.chatId).toBeNull()
    expect(recorded[0]?.door).toBe(Door.hook)
  })

  it('reads an empty chat env var as no chat', () => {
    expect(hookOrigin({ [ORC_CHAT_ID]: '' })).toEqual({ chatId: null, door: Door.hook })
  })

  // the hook must read the key the commit tool writes: spelling it here would let a rename in
  // contracts pass while the hook silently stopped seeing the chat.
  it('reads the chat from the env var contracts names', () => {
    expect(hookOrigin({ [ORC_CHAT_ID]: 'chat-9' })).toEqual({ chatId: 'chat-9', door: Door.hook })
  })
})
