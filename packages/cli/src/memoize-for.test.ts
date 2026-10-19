import { describe, expect, it } from 'bun:test'
import { memoizeFor } from './memoize-for'

const counting = (results: (() => string)[]) => {
  let calls = 0
  return { fn: async () => results[calls++ % results.length]?.() ?? '', calls: () => calls }
}

describe('memoizeFor', () => {
  it('runs fn once for two calls within ms', async () => {
    let t = 0
    const c = counting([() => 'a'])
    const get = memoizeFor(100, c.fn, () => t)
    await get()
    t = 99
    await get()
    expect(c.calls()).toBe(1)
  })
  it('runs fn again after ms', async () => {
    let t = 0
    const c = counting([() => 'a'])
    const get = memoizeFor(100, c.fn, () => t)
    await get()
    t = 100
    await get()
    expect(c.calls()).toBe(2)
  })
  it('does not cache a rejected call', async () => {
    const t = 0
    const c = counting([() => { throw new Error('boom') }, () => 'ok'])
    const get = memoizeFor(100, c.fn, () => t)
    await expect(get()).rejects.toThrow('boom')
    expect(await get()).toBe('ok')
    expect(c.calls()).toBe(2)
  })
})
