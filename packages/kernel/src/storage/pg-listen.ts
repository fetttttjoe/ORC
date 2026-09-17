import pg from 'pg'
import { errorMessage } from '@orc/contracts'

// The connect → LISTEN → 'error' handler → 'end' → reconnect-with-backoff → close loop, shared by
// every long-lived Postgres LISTEN (EventLog.subscribe, watchProjectIds). Each caller supplies only
// what differs: what to do on notification, what to do right after (re)connecting, and how to tell
// a permanent failure from a transient one. The loop, the backoff table, and the two "must not
// crash / must not spam" comments below are the part that was drifting between two copies.
export const RECONNECT_DELAYS_MS: readonly [number, ...number[]] = [100, 200, 400, 800, 1600, 3000]

export interface PgListenOpts {
  url: string
  applicationName: string
  channel: string
  onNotification: (payload: string | undefined) => void
  onConnected: () => void | Promise<void>
  isGonePermanently: (err: unknown) => boolean
  // fired once when the loop gives up for good: the caller owns other timers (a pump retry, a
  // debounce) that must quiesce with it, or they spin against the vanished database forever
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
    const c = new pg.Client({ connectionString: url, application_name: applicationName })
    // an 'error' event with no listener crashes the process (Node default), so the handler must
    // stay attached even after close — but it must stop TALKING, the way the 'end' handler
    // already does. A subscription that was disposed has nothing to report: the socket dying
    // afterwards is the expected consequence of closing it, and warning about it prints an
    // alarming line after the caller's work already finished.
    c.on('error', err => { if (!closed) warn(`listener error: ${errorMessage(err)}`) })
    try {
      await c.connect()
      await c.query(`LISTEN ${channel}`)
      // the disposer may have run during the awaits above; if so, don't adopt this fresh LISTEN
      // client — the disposer already ended the previous `client` and left.
      if (closed) { await c.end().catch(() => {}); return }
      client = c
      c.on('notification', msg => onNotification(msg.payload))
      c.once('end', () => { if (!closed) scheduleReconnect() })
      await onConnected()
      backoff = 0
    } catch (err) {
      await c.end().catch(() => {})
      if (initial) {
        // Nothing owns this subscription yet: the caller receives a throw and NO disposer, so
        // `closed` can never be set and any timer still armed reconnects forever with no way to
        // stop it. `c.end()` above fires the 'end' handler, which schedules exactly such a
        // reconnect — so the teardown the disposer would have done has to happen here instead.
        closed = true
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
        throw err
      }
      // isGonePermanently's caller-supplied verdict: a failure that retrying can never fix (see
      // its definition in postgres.ts for which codes and why). Stop, and say so once.
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
