import { describe, expect, it } from 'bun:test'
import { WORKSPACE_KIND, Workspace } from '@orc/contracts'
import { createHealTarget } from './heal-target'
import { archivedRefusal } from './workspace-ops'

const DEFAULT_DIR = '/repo/main'
const workspace = (id: string, cwd: string, archivedAt: string | null): Workspace => Workspace.parse({
  id, title: id, cwd, branch: null, baseBranch: null, kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: false,
  createdAt: '2026-09-14T00:00:00.000Z', archivedAt,
})

const MAIN = workspace('11111111-1111-4111-8111-111111111111', DEFAULT_DIR, null)
const LIVE = workspace('22222222-2222-4222-8222-222222222222', '/repo/.orc/worktrees/live', null)
const ARCHIVED = workspace('33333333-3333-4333-8333-333333333333', '/repo/.orc/worktrees/old', '2026-09-15T00:00:00.000Z')

const healTarget = createHealTarget({
  kernel: { state: async () => ({ workspaces: new Map([MAIN, LIVE, ARCHIVED].map(w => [w.id, w])) }) },
  dir: DEFAULT_DIR,
})

describe('createHealTarget', () => {
  it('null is the default directory and its own workspace', async () => {
    expect(await healTarget(null)).toEqual({ id: MAIN.id, dir: DEFAULT_DIR })
  })

  it('a live workspace is read in its own cwd', async () => {
    expect(await healTarget(LIVE.id)).toEqual({ id: LIVE.id, dir: LIVE.cwd })
  })

  it('an archived workspace is refused', async () => {
    await expect(healTarget(ARCHIVED.id)).rejects.toThrow(archivedRefusal(ARCHIVED.id))
  })

  it('an unknown workspace is refused', async () => {
    await expect(healTarget('44444444-4444-4444-8444-444444444444')).rejects.toThrow('44444444-4444-4444-8444-444444444444')
  })
})
