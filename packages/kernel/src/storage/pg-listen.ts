import pg from 'pg'
import { errorMessage } from '@orc/contracts'
import { PG_CONNECT_OPTIONS } from './postgres'

export const RECONNECT_DELAYS_MS: readonly [number, ...number[]] = [100, 200, 400, 800, 1600, 3000]

export interface PgListenOpts {
  url: string
  applicationName: string
  channel: string
  onNotification: (payload: string | undefined) => void
  onConnected: () => void | Promise<void>
  isGonePermanently: (err: unknown) => boolean
  // fired once on a permanent stop: the caller's retry and debounce timers must quiesce
  onStopped: () => void
  warn: (msg: string) => void
}

export interface PgListenHandle {
  close(): Promise<void>
}

export async function pgListen(opts: PgListenOpts): Promise<PgListenHandle> {
  const { url, applicationName, channel, onNotification, onConnected, isGonePermanently, onStopped, warn } = opts
  let closed = false
  let client: pg.Client | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 0

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return
    const delay = RECONNECT_DELAYS_MS[Math.min(backoff, RECONNECT_DELAYS_MS.length - 1)] ?? RECONNECT_DELAYS_MS[0]
    backoff += 1
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(false) }, delay)
  }

  const connect = async (initial: boolean): Promise<void> => {
    if (closed) return
    const c = new pg.Client({ connectionString: url, application_name: applicationName, ...PG_CONNECT_OPTIONS })
    // stays attached after close (an unhandled 'error' crashes the process) but goes silent
    c.on('error', err => { if (!closed) warn(`listener error: ${errorMessage(err)}`) })
    try {
      await c.connect()
      await c.query(`LISTEN ${channel}`)
      // the disposer ran during the awaits: do not adopt this fresh LISTEN client
      if (closed) { await c.end().catch(() => {}); return }
      client = c
      c.on('notification', msg => onNotification(msg.payload))
      c.once('end', () => { if (!closed) scheduleReconnect() })
      await onConnected()
      backoff = 0
    } catch (err) {
      await c.end().catch(() => {})
      if (initial) {
        // a throw hands the caller no disposer, so the reconnect c.end() schedules must stop here
        closed = true
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
        throw err
      }
      if (isGonePermanently(err)) {
        closed = true
        warn(`stopped: ${errorMessage(err)}`)
        onStopped()
        return
      }
      warn(`reconnect failed: ${errorMessage(err)}`)
      scheduleReconnect()
    }
  }

  await connect(true)
  return {
    async close() {
      closed = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      client?.removeAllListeners('notification')
      await client?.end().catch(() => {})
    },
  }
}
