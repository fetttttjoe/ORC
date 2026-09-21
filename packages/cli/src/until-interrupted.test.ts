import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { SHUTDOWN_SIGNALS, untilInterrupted } from './until-interrupted'

const settled = async (p: Promise<void>): Promise<boolean> =>
  Promise.race([p.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 20))])

describe('untilInterrupted', () => {
  it('stays pending until a shutdown signal arrives', async () => {
    expect(await settled(untilInterrupted(new EventEmitter()))).toBe(false)
  })

  for (const signal of SHUTDOWN_SIGNALS) {
    it(`resolves on ${signal} and leaves no listener behind`, async () => {
      const source = new EventEmitter()
      const waiting = untilInterrupted(source)
      source.emit(signal)
      expect(await settled(waiting)).toBe(true)
      expect(SHUTDOWN_SIGNALS.map(s => source.listenerCount(s))).toEqual([0, 0])
    })
  }
})
