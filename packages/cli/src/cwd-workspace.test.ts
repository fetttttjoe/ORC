import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUTHOR_SOURCE, Door, NO_CHAT, WORKSPACE_KIND, type Workspace } from '@orc/contracts'
import { authorFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { cwdAuthor, cwdWorkspaceId, type WorkspaceFold } from './cwd-workspace'

// a real directory: a made-up path would exercise the ENOENT fallback instead
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-cwd-ws-')))

const workspace: Workspace = {
  id: TEST_WORKSPACE_ID, title: 'test', cwd: dir, branch: 'main', baseBranch: null,
  kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
}

const kernelWith = (...ws: Workspace[]): WorkspaceFold =>
  ({ state: async () => ({ workspaces: new Map(ws.map(w => [w.id, w])) }) })

describe('cwdAuthor', () => {
  it('stamps the cwd workspace onto the author, keeping the caller-supplied door and extras', async () => {
    const author = await cwdAuthor(kernelWith(workspace), dir, AUTHOR_SOURCE.agent, NO_CHAT(Door.mcp), { executor: 'mcp-serve' })
    expect(author).toEqual(authorFixture({ source: AUTHOR_SOURCE.agent, origin: NO_CHAT(Door.mcp), executor: 'mcp-serve' }))
  })
  it('defaults to no extras and still names the workspace', async () => {
    expect(await cwdAuthor(kernelWith(workspace), dir, AUTHOR_SOURCE.cli, NO_CHAT(Door.cli)))
      .toEqual(authorFixture())
  })
  it('THROWS on a directory no workspace claims — a writer that cannot name its workspace is a wiring bug, never a placeholder', async () => {
    await expect(cwdAuthor(kernelWith(), dir, AUTHOR_SOURCE.cli, NO_CHAT(Door.cli))).rejects.toThrow('no workspace for this directory')
    await expect(cwdWorkspaceId(kernelWith(), dir)).rejects.toThrow('no workspace for this directory')
  })
})
