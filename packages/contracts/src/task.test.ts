import { describe, expect, it } from 'bun:test'
import { TaskNode, type TaskNode as TaskNodeType } from './task'

const valid: TaskNodeType = {
  id: 'a', parentId: null, type: 'generic', title: 'hello', spec: '',
  status: 'draft', zone: [], budgetUSD: null, depth: 0,
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
})
