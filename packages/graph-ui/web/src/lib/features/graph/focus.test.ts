import { describe, expect, test } from 'bun:test'
import { focusReach } from './focus'

const link = (source: string, target: string): { source: string; target: string } => ({ source, target })

describe('focusReach', () => {
  test('follows the projection edges outward: steps, artifacts, model', () => {
    const keep = focusReach('taskA', [
      link('taskA', 'step:taskA:s1'),
      link('step:taskA:s1', 'artifact:a1'),
      link('taskA', 'model:m'),
    ])
    expect([...keep].sort()).toEqual(['artifact:a1', 'model:m', 'step:taskA:s1', 'taskA'].sort())
  })

  test('never flows backward through a shared hub — the flood that made focus dim nothing', () => {
    const keep = focusReach('taskA', [
      link('taskA', 'model:m'),
      link('taskB', 'model:m'),
      link('taskB', 'step:taskB:s1'),
      link('step:taskB:s1', 'artifact:other'),
    ])
    expect(keep.has('model:m')).toBe(true)
    expect(keep.has('taskB')).toBe(false)
    expect(keep.has('step:taskB:s1')).toBe(false)
    expect(keep.has('artifact:other')).toBe(false)
  })

  test('a child task is the request\'s work; the parent is not the child\'s', () => {
    const links = [link('parent', 'child'), link('child', 'step:child:s1')]
    expect(focusReach('parent', links).has('child')).toBe(true)
    expect(focusReach('child', links).has('parent')).toBe(false)
  })

  test('a cycle terminates', () => {
    const keep = focusReach('a', [link('a', 'b'), link('b', 'a')])
    expect([...keep].sort()).toEqual(['a', 'b'])
  })
})
