import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, Door, EVENT_KIND, MemoryAuthor, NO_CHAT, PAYLOAD_SCHEMAS, TaskNode } from './index'
import { authorFixture } from './fixtures'
import { WORKSPACE_KIND, Workspace, WorkspaceArchivedPayload } from './workspace-entity'

const ws = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Add ingredient search', cwd: '/repo/.orc/worktrees/add-ingredient-search',
  branch: 'orc/add-ingredient-search', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false,
  createdAt: '2026-09-14T00:00:00.000Z', archivedAt: null,
}

describe('Workspace', () => {
  it('parses a managed worktree and an adopted checkout', () => {
    expect(Workspace.parse(ws).kind).toBe(WORKSPACE_KIND.worktree)
    expect(Workspace.parse({ ...ws, kind: WORKSPACE_KIND.checkout, managed: false, baseBranch: null, branch: null }).branch).toBeNull()
  })
  it('refuses an unknown kind and an empty cwd', () => {
    expect(Workspace.safeParse({ ...ws, kind: 'folder' }).success).toBe(false)
    expect(Workspace.safeParse({ ...ws, cwd: '' }).success).toBe(false)
  })
  it('archivedAt and onTrunk are required keys — a workspace record never defaults silently', () => {
    const { archivedAt: _a, ...noArchived } = ws
    expect(Workspace.safeParse(noArchived).success).toBe(false)
    const { onTrunk: _t, ...noTrunk } = ws
    expect(Workspace.safeParse(noTrunk).success).toBe(false)
  })
  it('every workspace event kind has a payload schema keyed by its own name', () => {
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.workspace_created].safeParse({ workspace: ws }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.workspace_retitled].safeParse({ workspaceId: ws.id, title: 'x' }).success).toBe(true)
    expect(WorkspaceArchivedPayload.safeParse({ workspaceId: ws.id, archived: true, at: ws.createdAt }).success).toBe(true)
    expect(WorkspaceArchivedPayload.safeParse({ workspaceId: ws.id }).success).toBe(false) // archived is a required PARAMETER
  })
  it('workspace_merged parses the full merge payload and refuses one missing mergeCommit', () => {
    const merged = { workspaceId: ws.id, mergeCommit: 'deadbeef', trunk: 'main', at: ws.createdAt }
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.workspace_merged].safeParse(merged).success).toBe(true)
    const { mergeCommit: _m, ...noMergeCommit } = merged
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.workspace_merged].safeParse(noMergeCommit).success).toBe(false)
  })
})

describe('TaskNode.workspaceId', () => {
  const base = { id: 't', parentId: null, type: 'generic', title: 'T', spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: '2026-01-01T00:00:00.000Z' }
  it('is required — a task without a workspace is refused at the payload boundary', () => {
    expect(TaskNode.safeParse(base).success).toBe(false)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.task_created].safeParse({ task: base }).success).toBe(false)
    expect(TaskNode.parse({ ...base, workspaceId: ws.id }).workspaceId).toBe(ws.id)
  })
})

describe('MemoryAuthor.workspaceId', () => {
  it('is required on EVERY author — a write that cannot name its workspace is refused, not defaulted', () => {
    expect(MemoryAuthor.safeParse({ source: AUTHOR_SOURCE.cli }).success).toBe(false)
    expect(MemoryAuthor.safeParse({ source: AUTHOR_SOURCE.agent, taskId: 't1' }).success).toBe(false)
    expect(MemoryAuthor.safeParse({ source: AUTHOR_SOURCE.agent, workspaceId: '' }).success).toBe(false)
  })
  it('round-trips an agent author carrying the workspace it wrote from', () => {
    const origin = NO_CHAT(Door.cli)
    expect(MemoryAuthor.parse({ source: AUTHOR_SOURCE.agent, workspaceId: ws.id, origin })).toEqual({ source: AUTHOR_SOURCE.agent, workspaceId: ws.id, origin })
  })
  // The door is the half of the provenance that is never null, so an author that named only a chat
  // would read back as having come from nowhere on every chatless write.
  it('requires a full origin — a bare chatId does not satisfy it', () => {
    expect(MemoryAuthor.safeParse({ source: AUTHOR_SOURCE.cli, workspaceId: ws.id, chatId: null }).success).toBe(false)
    expect(MemoryAuthor.safeParse({ source: AUTHOR_SOURCE.cli, workspaceId: ws.id, origin: { chatId: null } }).success).toBe(false)
    expect(MemoryAuthor.parse({ source: AUTHOR_SOURCE.cli, workspaceId: ws.id, origin: NO_CHAT(Door.mcp) }).origin.door).toBe(Door.mcp)
  })
  it('authorFixture names the chatless CLI origin every test-side author shares', () => {
    expect(authorFixture().origin).toEqual(NO_CHAT(Door.cli))
  })
  it('the required key reaches every author-bearing payload, not just the write', () => {
    const note = { id: 'n', title: 'N' }
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_written].safeParse({ note, author: { source: AUTHOR_SOURCE.cli } }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_written].safeParse({ note, author: authorFixture({ workspaceId: ws.id }) }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_deleted].safeParse({ id: 'n', scope: 'project', author: { source: AUTHOR_SOURCE.cli } }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.feedback_provided].safeParse({ topic: 't', text: 'yes', author: { source: AUTHOR_SOURCE.cli } }).success).toBe(false)
  })
})
