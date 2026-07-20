import { describe, expect, it, mock, spyOn } from 'bun:test'
import { HOOK_NAME } from '@orc/contracts'
import { HookBus } from './hooks'

describe('HookBus', () => {
  it('runs handlers in registration order and awaits async ones', async () => {
    const bus = new HookBus()
    const calls: string[] = []
    bus.on(HOOK_NAME.session_start, () => { calls.push('a') })
    bus.on(HOOK_NAME.session_start, async () => {
      await new Promise(r => setTimeout(r, 10))
      calls.push('b')
    })
    await bus.emit(HOOK_NAME.session_start)
    expect(calls).toEqual(['a', 'b'])
  })

  it('dispatch tracks detached handlers until drain completes', async () => {
    const bus = new HookBus()
    const calls: string[] = []
    bus.on(HOOK_NAME.event_appended, async () => {
      await Bun.sleep(25)
      calls.push('done')
    })
    expect(typeof bus.dispatch).toBe('function')

    bus.dispatch(HOOK_NAME.event_appended, {
      seq: 1, ts: 't', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null,
      kind: 'task_status_changed', payload: { taskId: 't1', from: 'draft', to: 'awaiting_approval' }, usage: null,
    })
    expect(calls).toEqual([])
    await bus.drain()
    expect(calls).toEqual(['done'])
  })

  it('a throwing handler is contained and later handlers still run', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bus = new HookBus()
      const calls: string[] = []
      bus.on(HOOK_NAME.event_appended, () => { throw new Error('boom') })
      bus.on(HOOK_NAME.event_appended, () => { calls.push('after') })
      await bus.emit(HOOK_NAME.event_appended, {
        seq: 1, ts: 't', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null,
        kind: 'task_status_changed', payload: { taskId: 't1', from: 'draft', to: 'awaiting_approval' }, usage: null,
      })
      expect(calls).toEqual(['after'])
      expect(warn).toHaveBeenCalled()
    } finally {
      mock.restore()
    }
  })

  it('emitting a hook with no handlers is a no-op', async () => {
    await new HookBus().emit(HOOK_NAME.session_shutdown)
  })
})
