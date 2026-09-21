import { afterAll, describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, NO_CHAT, type EventRecord } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testOrcConfig } from '@orc/kernel/test-helpers'
import { openKernel } from './main'
import { formatStreamLine, watchStream, type EventFeed } from './stream-watch'

const CLI = NO_CHAT(Door.cli)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('formatStreamLine', () => {
  it('renders seq, kind and the summary line summarizeEvent produces', () => {
    const e = eventFixture({ seq: 7, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: 'draft', to: 'approved' } })
    const expected = `${'7'.padStart(5)}  ${'task_status_changed'.padEnd(24)}  draft → approved`
    expect(formatStreamLine(e)).toBe(expected)
  })

  it('falls back to the generic snip when a payload fails its schema parse, still carrying seq + kind', () => {
    const e = eventFixture({ seq: 123, kind: EVENT_KIND.run_started, payload: { workflowId: 'w1', planVersion: 1 } })
    const line = formatStreamLine(e)
    expect(line).toContain('  123')
    expect(line).toContain('run_started')
    expect(line).toContain('w1')
  })
})

// An in-memory Kernel['subscribe'] stand-in — records each subscribe call's options and lets a
// test push events straight at the registered handler, with no database behind it.
function fakeFeed(): EventFeed & { calls: Array<{ fromSeq?: number }>; push: (e: EventRecord) => Promise<void> } {
  let handler: ((e: EventRecord) => void | Promise<void>) | null = null
  const calls: Array<{ fromSeq?: number }> = []
  return {
    calls,
    subscribe: async (opts, h) => {
      calls.push(opts)
      handler = h
      return async () => { handler = null }
    },
    push: async e => { await handler?.(e) },
  }
}

describe('watchStream', () => {
  it('formats each delivered event the way formatStreamLine does', async () => {
    const feed = fakeFeed()
    const lines: string[] = []
    const unsub = await watchStream(feed, {}, l => lines.push(l))
    const e = eventFixture({ seq: 7, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: 'draft', to: 'approved' } })
    await feed.push(e)
    await unsub()
    expect(lines).toEqual([formatStreamLine(e)])
  })

  it('--kind filters to only the named kinds', async () => {
    const feed = fakeFeed()
    const lines: string[] = []
    const unsub = await watchStream(feed, { kinds: [EVENT_KIND.plan_proposed] }, l => lines.push(l))
    await feed.push(eventFixture({ seq: 1, kind: EVENT_KIND.task_created }))
    await feed.push(eventFixture({ seq: 2, kind: EVENT_KIND.plan_proposed }))
    await unsub()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain(EVENT_KIND.plan_proposed)
  })

  it('an empty --kind list is no filter at all', async () => {
    const feed = fakeFeed()
    const lines: string[] = []
    const unsub = await watchStream(feed, { kinds: [] }, l => lines.push(l))
    await feed.push(eventFixture({ seq: 1, kind: EVENT_KIND.task_created }))
    await unsub()
    expect(lines.length).toBe(1)
  })

  it("--since is forwarded to the feed as the subscription's fromSeq", async () => {
    const feed = fakeFeed()
    const unsub = await watchStream(feed, { since: 42 }, () => {})
    await unsub()
    expect(feed.calls).toEqual([{ fromSeq: 42 }])
  })

  const dbs: Array<{ drop: () => Promise<void> }> = []
  const cleanup: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c()
    await Promise.all(dbs.map(d => d.drop()))
  }, 30_000)

  // the one test against the real wiring: a real EventLog's subscribe, and --since replay against it
  it('--since replays only events after that seq, never the ones at or before it, against a real event log', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    cleanup.push(() => storage.close())
    await seedTestWorkspace(storage.events, CLI)

    const first = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'before' }, CLI)
    const events = await kernel.eventsFor(first.id)
    const since = events.at(-1)?.seq ?? 0

    const lines: string[] = []
    const unsub = await watchStream(kernel, { since }, l => lines.push(l))
    try {
      await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'after' }, CLI)
      await sleep(200)
      // exactly one task_created — the one created AFTER `since`, never the seeded one at/before it
      expect(lines.filter(l => l.includes(EVENT_KIND.task_created)).length).toBe(1)
    } finally {
      await unsub()
    }
  })
})
