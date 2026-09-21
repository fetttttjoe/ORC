import { afterEach, describe, expect, it } from 'bun:test'
import net from 'node:net'
import pg from 'pg'
import { createTestDb, waitFor } from '../test-helpers'
import { pgListen, RECONNECT_DELAYS_MS, type PgListenHandle } from './pg-listen'
import { isGonePermanently, NOTIFY_CHANNEL, TERMINAL_PG_CODES } from './postgres'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const dbs: Array<{ drop: () => Promise<void> }> = []
const handles: PgListenHandle[] = []
const relays: Array<{ stopAccepting: () => void }> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {})
  for (const r of relays.splice(0)) r.stopAccepting()
  for (const d of dbs.splice(0)) await d.drop()
})

function startRelay(targetPort: number, targetHost: string): Promise<{ port: number; stopAccepting: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      const upstream = net.createConnection({ host: targetHost, port: targetPort })
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.on('error', () => {})
      upstream.on('error', () => {})
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('relay: no port assigned')); return }
      resolve({ port: addr.port, stopAccepting: () => server.close(() => {}) })
    })
  })
}

describe('isGonePermanently', () => {
  for (const code of TERMINAL_PG_CODES) {
    it(`is true for terminal pg code ${code}`, () => {
      expect(isGonePermanently({ code })).toBe(true)
    })
  }

  it('is false for a pg code that is not terminal', () => {
    expect(isGonePermanently({ code: '42601' })).toBe(false)
  })

  it('is false for a non-object error', () => {
    expect(isGonePermanently('boom')).toBe(false)
    expect(isGonePermanently(null)).toBe(false)
    expect(isGonePermanently(undefined)).toBe(false)
    expect(isGonePermanently(42)).toBe(false)
  })

  it('is false for an object with no code', () => {
    expect(isGonePermanently(new Error('boom'))).toBe(false)
    expect(isGonePermanently({})).toBe(false)
  })
})

describe('pgListen', () => {
  it('stops for good once its live database disappears — onStopped fires exactly once, nothing after', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const appName = `pg-listen-test-gone-${Math.random().toString(36).slice(2, 8)}`
    let stoppedCount = 0
    const warnings: string[] = []
    const handle = await pgListen({
      url: db.url,
      applicationName: appName,
      channel: NOTIFY_CHANNEL,
      onNotification: () => {},
      onConnected: () => {},
      isGonePermanently,
      onStopped: () => { stoppedCount += 1 },
      warn: msg => { warnings.push(msg) },
    })
    handles.push(handle)

    await db.drop() // pulls the database out from under a live LISTEN

    const stopped = await waitFor(async () => stoppedCount > 0, 3000)
    expect(stopped).toBe(true)
    expect(stoppedCount).toBe(1)

    const warningsAtStop = warnings.length
    await sleep(1200) // several backoff steps' worth of headroom — a spinning loop would act again
    expect(stoppedCount).toBe(1) // still exactly once
    expect(warnings.length).toBe(warningsAtStop) // no further connection attempts logged
    expect(warnings.filter(w => w.includes('reconnect failed')).length).toBe(0)

    await handle.close() // closes cleanly even though the underlying client is already gone
  })

  it('schedules reconnects with growing delays on a transient failure, not immediately', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dbUrl = new URL(db.url)
    const relay = await startRelay(Number(dbUrl.port), dbUrl.hostname)
    relays.push(relay)

    const proxied = new URL(db.url)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(relay.port)

    const appName = `pg-listen-test-backoff-${Math.random().toString(36).slice(2, 8)}`
    const attemptTimes: number[] = []
    let connectedOnce = false
    const handle = await pgListen({
      url: proxied.toString(),
      applicationName: appName,
      channel: NOTIFY_CHANNEL,
      onNotification: () => {},
      onConnected: () => { connectedOnce = true },
      isGonePermanently,
      onStopped: () => {},
      warn: msg => { if (msg.startsWith('reconnect failed')) attemptTimes.push(Date.now()) },
    })
    handles.push(handle)
    expect(connectedOnce).toBe(true) // the initial connect went through the relay, LISTEN adopted

    const admin = new pg.Pool({ connectionString: db.url })
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [appName])
    await admin.end()
    relay.stopAccepting()

    const gotThree = await waitFor(async () => attemptTimes.length >= 3, 3000)
    expect(gotThree).toBe(true)

    const [first, second, third] = attemptTimes
    const gap1 = second - first
    const gap2 = third - second
    expect(gap1).toBeGreaterThanOrEqual(RECONNECT_DELAYS_MS[0] * 0.5)
    expect(gap1).toBeLessThan(RECONNECT_DELAYS_MS[1] * 3)
    expect(gap2).toBeGreaterThan(gap1)
    expect(gap2).toBeGreaterThanOrEqual(RECONNECT_DELAYS_MS[1] * 0.5)

    await handle.close()
  }, 10000)
})
