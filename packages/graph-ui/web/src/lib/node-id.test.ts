import { describe, expect, test } from 'bun:test'
import { nodeKind, stepIdOf, taskIdOf } from './node-id'

describe('nodeKind', () => {
  test('bare id defaults to task', () => {
    expect(nodeKind('t1')).toBe('task')
    expect(nodeKind('t1.2')).toBe('task')
  })
  test('reads the prefix', () => {
    expect(nodeKind('step:t1:s1')).toBe('step')
    expect(nodeKind('artifact:t1:src/x.ts')).toBe('artifact')
    expect(nodeKind('model:anthropic:claude-fable-5')).toBe('model')
  })
})

describe('taskIdOf', () => {
  test('a task id owns itself', () => {
    expect(taskIdOf('t1')).toBe('t1')
  })
  test('step and artifact ids carry the task as second segment', () => {
    expect(taskIdOf('step:t1:s1')).toBe('t1')
    expect(taskIdOf('artifact:t1:dist/app.js')).toBe('t1')
  })
  test('artifact paths containing ":" do not shift the task segment', () => {
    expect(taskIdOf('artifact:t1:src/a:b.ts')).toBe('t1')
  })
  test('a model node has no owning task', () => {
    expect(taskIdOf('model:anthropic:claude-fable-5')).toBeNull()
  })
  test('a prefixed id missing its task segment yields null', () => {
    expect(taskIdOf('step:')).toBeNull()
    expect(taskIdOf('artifact:')).toBeNull()
  })
})

describe('stepIdOf', () => {
  test('step:<task>:<step> yields the step', () => {
    expect(stepIdOf('step:t1:s1')).toBe('s1')
  })
  test('a step segment containing ":" keeps the remainder joined', () => {
    expect(stepIdOf('step:t1:s:1')).toBe('s:1')
  })
  test('non-step ids yield null', () => {
    expect(stepIdOf('t1')).toBeNull()
    expect(stepIdOf('artifact:t1:src/a:b.ts')).toBeNull()
  })
  test('a step id missing its step segment yields null', () => {
    expect(stepIdOf('step:t1')).toBeNull()
  })
})
