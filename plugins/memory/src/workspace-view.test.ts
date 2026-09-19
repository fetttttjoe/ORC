import { afterAll, describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, NO_CHAT, WORKSPACE_KIND, type Origin } from '@orc/contracts'
import { openStorage } from '@orc/kernel'
import { TEST_PROJECT_ID, createTestDb } from '@orc/kernel/test-helpers'
import { createWorkspaceView } from './workspace-view'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

// Workspaces here are made and merged by `orc ws` commands, which answer to no chat.
const CLI: Origin = NO_CHAT(Door.cli)

const workspace = (id: string, over: { onTrunk?: boolean; title?: string } = {}) => ({
  id, title: over.title ?? 'w', cwd: `/tmp/${id}`, branch: 'feat', baseBranch: 'main',
  kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: over.onTrunk ?? false,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
})

// The wiring between the kernel's fold and the pure derivation — the half neither side's own tests
// can see. `provisionalOf` is exercised against a hand-built map, and the tools are driven through a
// stub dep, so a view that mapped the wrong half of the fold (the merge RECORDS instead of their
// keys, say) would leave both green while every note read as final forever.
describe('createWorkspaceView', () => {
  it('reads standing off the log and reflects a merge recorded after the probe was built', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    try {
      const id = '00000000-0000-4000-8000-0000000000aa'
      const trunk = '00000000-0000-4000-8000-0000000000bb'
      await log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_created, payload: { workspace: workspace(id, { title: 'Requests rework' }) } })
      await log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_created, payload: { workspace: workspace(trunk, { onTrunk: true, title: 'main' }) } })

      // built ONCE, like a composition root does it — every assertion below re-reads through it
      const view = createWorkspaceView(log)

      const before = await view()
      expect(before.workspaces.get(id)).toMatchObject({ onTrunk: false, title: 'Requests rework' })
      expect(before.workspaces.get(trunk)?.onTrunk).toBe(true)
      expect(before.merged.size).toBe(0)

      await log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_merged, payload: { workspaceId: id, mergeCommit: 'abc123', trunk: 'main', at: '2026-01-02T00:00:00.000Z' } })
      // the whole reason the dep is a callback and not a snapshot: a merge landing mid-session has
      // to clear the flag on the next read, with nothing rebuilt
      const after = await view()
      expect([...after.merged]).toEqual([id])

      // a RETITLE moves what the flag shows a human, so that kind has to be in the scoped query too
      await log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_retitled, payload: { workspaceId: id, title: 'Requests rework (v2)' } })
      expect((await view()).workspaces.get(id)?.title).toBe('Requests rework (v2)')

      // ARCHIVING does not remove the record from the fold — it stamps archivedAt on it. So an
      // archived workspace stays KNOWN to the view and its unmerged notes keep flagging, which is
      // correct: archiving a checkout does not put its work on trunk. Pinned because provisionalOf's
      // unknown-workspace branch reads as if archiving were the way a workspace goes missing, and it
      // is not — the only way is a `workspace_created` the fold never saw.
      const other = '00000000-0000-4000-8000-0000000000cc'
      await log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_created, payload: { workspace: workspace(other, { title: 'Abandoned' }) } })
      await log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.workspace_archived, payload: { workspaceId: other, archived: true, at: '2026-01-03T00:00:00.000Z' } })
      const archived = await view()
      expect(archived.workspaces.get(other)).toMatchObject({ onTrunk: false, title: 'Abandoned' })
      expect(archived.merged.has(other)).toBe(false)
    } finally {
      await log.close()
    }
  })
})
