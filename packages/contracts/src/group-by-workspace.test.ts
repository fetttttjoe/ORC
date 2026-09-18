import { describe, expect, it } from 'bun:test'
import { groupByWorkspace } from './group-by-workspace'

describe('groupByWorkspace', () => {
  const ws = [{ id: 'a' }, { id: 'b' }]
  it('keeps workspace order and gives an empty workspace an empty group', () => {
    const out = groupByWorkspace(ws, [{ workspaceId: 'b', n: 1 }])
    expect(out).toEqual([{ workspace: { id: 'a' }, items: [] }, { workspace: { id: 'b' }, items: [{ workspaceId: 'b', n: 1 }] }])
  })
  it('drops an item naming an unknown workspace rather than inventing a group for it', () => {
    expect(groupByWorkspace(ws, [{ workspaceId: 'zz' }]).flatMap(g => g.items)).toEqual([])
  })
})
