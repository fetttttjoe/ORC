import { describe, expect, it } from 'bun:test'
import { TaskNode, TaskStatus, TaskType, type TaskNode as TaskNodeType } from './task'
import { TEST_WORKSPACE_ID } from './fixtures'

const valid: TaskNodeType = {
  id: 'a', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: TaskType.generic, title: 'hello', spec: '',
  status: TaskStatus.draft, zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-07-16T00:00:00.000Z',
}

describe('TaskNode', () => {
  it('parses a valid node', () => {
    expect(TaskNode.parse(valid)).toEqual(valid)
  })
  it('rejects unknown status', () => {
    expect(() => TaskNode.parse({ ...valid, status: 'nope' })).toThrow()
  })
  it('rejects negative depth', () => {
    expect(() => TaskNode.parse({ ...valid, depth: -1 })).toThrow()
  })
  it('parses every TaskType member', () => {
    for (const type of Object.values(TaskType))
      expect(TaskNode.parse({ ...valid, type }).type).toBe(type)
  })
  it('rejects an unknown type', () => {
    expect(() => TaskNode.parse({ ...valid, type: 'nope' })).toThrow()
  })
})
