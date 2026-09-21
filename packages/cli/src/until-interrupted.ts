export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const

export interface SignalSource {
  once(signal: string, listener: () => void): unknown
  off(signal: string, listener: () => void): unknown
}

export const untilInterrupted = (source: SignalSource = process): Promise<void> =>
  new Promise(resolve => {
    const done = (): void => {
      for (const signal of SHUTDOWN_SIGNALS) source.off(signal, done)
      resolve()
    }
    for (const signal of SHUTDOWN_SIGNALS) source.once(signal, done)
  })
