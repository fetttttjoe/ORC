import type { HookHandlers, HookName } from '@orc/contracts'
import { errorMessage } from '@orc/contracts'

// observe-only: handlers see, never veto; errors are contained; a handler may fire twice
export class HookBus {
  private handlers = new Map<HookName, Array<(...args: never[]) => unknown>>()
  private pending = new Set<Promise<void>>()

  on<H extends HookName>(hook: H, handler: HookHandlers[H]): void {
    const list = this.handlers.get(hook) ?? []
    list.push(handler as (...args: never[]) => unknown)
    this.handlers.set(hook, list)
  }

  async emit<H extends HookName>(hook: H, ...args: Parameters<HookHandlers[H]>): Promise<void> {
    for (const h of this.handlers.get(hook) ?? []) {
      try {
        await (h as (...a: Parameters<HookHandlers[H]>) => unknown)(...args)
      } catch (err) {
        console.warn(`hook '${hook}' handler failed: ${errorMessage(err)}`)
      }
    }
  }

  dispatch<H extends HookName>(hook: H, ...args: Parameters<HookHandlers[H]>): void {
    const pending = this.emit(hook, ...args).finally(() => { this.pending.delete(pending) })
    this.pending.add(pending)
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending)
  }
}
