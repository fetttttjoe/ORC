import { describe, expect, it } from 'bun:test'
import type { PlanAnnotation } from '../kernel'
import { readAnnotationsTool } from './read-annotations-tool'

const p = { taskId: 't1' }

describe('read_annotations tool', () => {
  it('returns the annotations the kernel has recorded for this task', async () => {
    const annotations: PlanAnnotation[] = [
      { targetNote: 'db', refs: ['api'], text: 'use bcrypt', planVersion: 1, seq: 5 },
      { targetNote: 'api', refs: [], text: 'add rate limiting', planVersion: 1, seq: 6 },
    ]
    const calls: string[] = []
    const kernel = { listAnnotations: async (taskId: string) => { calls.push(taskId); return annotations } }
    const tool = readAnnotationsTool({ kernel, p })
    expect(tool.name).toBe('read_annotations')
    const r = await tool.execute({})
    expect(r.isError).toBe(false)
    expect(r.output).toEqual({ annotations })
    expect(calls).toEqual(['t1'])
  })

  it('returns an empty list when the task has no annotations', async () => {
    const kernel = { listAnnotations: async () => [] }
    const tool = readAnnotationsTool({ kernel, p })
    const r = await tool.execute({})
    expect(r.isError).toBe(false)
    expect(r.output).toEqual({ annotations: [] })
  })

  it('surfaces a kernel failure as isError, never a throw', async () => {
    const kernel = { listAnnotations: async () => { throw new Error('log unavailable') } }
    const tool = readAnnotationsTool({ kernel, p })
    const r = await tool.execute({})
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('log unavailable')
  })
})
