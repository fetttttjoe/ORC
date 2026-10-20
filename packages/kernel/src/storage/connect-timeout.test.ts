import { afterEach, describe, expect, it } from 'bun:test'
import net from 'node:net'
import { isDatabaseUnreachable } from '../errors'
import { CONNECT_TIMEOUT_MS } from './postgres'
import { openStorage } from './index'

const TEST_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 2_000

// a server that accepts and never speaks: the pg handshake can only time out, never fail fast
function startSilentServer(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>()
    const server = net.createServer(socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('silent server: no port assigned')); return }
      resolve({
        port: addr.port,
        close: () => new Promise<void>(res => {
          for (const socket of sockets) socket.destroy()
          server.close(() => res())
        }),
      })
    })
  })
}

describe('pg connect timeout', () => {
  let server: { port: number; close(): Promise<void> } | null = null
  afterEach(async () => { await server?.close(); server = null })

  it('openStorage gives up within CONNECT_TIMEOUT_MS against a silent TCP server', async () => {
    server = await startSilentServer()
    const url = `postgresql://user:pass@127.0.0.1:${server.port}/db`

    const start = Date.now()
    let caught: unknown
    try {
      await openStorage(url, { projectId: '00000000-0000-4000-8000-000000000001' })
    } catch (err) {
      caught = err
    }
    const elapsed = Date.now() - start

    expect(caught).toBeDefined()
    expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS)
    expect(isDatabaseUnreachable(caught)).toBe(true)
  }, TEST_TIMEOUT_MS + 2_000)
})
