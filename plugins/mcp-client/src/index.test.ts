import { afterAll, describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import type { McpServerConfig } from '@orc/contracts'
import { createMcpHub } from './index'

const FIXTURE = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))
const SERVERS: Record<string, McpServerConfig> = { fixture: { command: 'bun', args: [FIXTURE] } }
const hubs: Array<{ close(): Promise<void> }> = []
const makeHub = (trusted = new Set(['fixture']), servers = SERVERS) => {
  const hub = createMcpHub(servers, trusted)
  hubs.push(hub)
  return hub
}
afterAll(async () => { for (const h of hubs) await h.close() })

describe('createMcpHub', () => {
  it('resolves refs into mangled, schema-bearing, executable tools', async () => {
    const hub = makeHub()
    const [echo] = await hub.resolve(['fixture/echo'])
    expect(echo!.name).toBe('mcp__fixture__echo')
    expect(echo!.ref).toBe('fixture/echo')
    expect(echo!.description).toBe('echo text back')
    expect((echo!.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty('text')
    const r = await echo!.execute({ text: 'hi' })
    expect(r.isError).toBe(false)
    expect(JSON.stringify(r.output)).toContain('echo: hi')
  })

  it('maps MCP isError to tool-result isError (server-declared and invalid-args)', async () => {
    const hub = makeHub()
    const [fail, echo] = await hub.resolve(['fixture/fail', 'fixture/echo'])
    expect((await fail!.execute({})).isError).toBe(true)
    expect((await echo!.execute({ wrong: 1 })).isError).toBe(true) // server-side zod validation
  })

  it('throws on undeclared server, untrusted server, and unknown tool', async () => {
    const hub = makeHub()
    await expect(hub.resolve(['ghost/x'])).rejects.toThrow(/undeclared/)
    await expect(hub.resolve(['fixture/nosuch'])).rejects.toThrow(/unknown tool/)
    const untrusted = makeHub(new Set())
    await expect(untrusted.resolve(['fixture/echo'])).rejects.toThrow(/not trusted/)
  })

  it('listChanged invalidates the tool cache', async () => {
    const hub = makeHub()
    await expect(hub.resolve(['fixture/late'])).rejects.toThrow(/unknown tool/)
    const [grow] = await hub.resolve(['fixture/grow'])
    await grow!.execute({})
    // list_changed arrives async; poll briefly
    const deadline = Date.now() + 2000
    let ok = false
    while (Date.now() < deadline && !ok) {
      try {
        await hub.resolve(['fixture/late'])
        ok = true
      } catch {
        await new Promise(r => setTimeout(r, 50))
      }
    }
    expect(ok).toBe(true)
  })

  it('listTools lists names and descriptions without a prior resolve', async () => {
    const hub = makeHub()
    const tools = await hub.listTools('fixture')
    expect(tools.map(t => t.name)).toContain('echo')
  })

  it('a crashing server surfaces a clear error, not a hang', async () => {
    const hub = makeHub(new Set(['fixture']), {
      fixture: { command: 'bun', args: [FIXTURE], env: { FIXTURE_CRASH: '1' } },
    })
    await expect(hub.resolve(['fixture/echo'])).rejects.toThrow()
  })

  it('a dead server mid-call yields an isError result and respawns on the next call', async () => {
    const hub = makeHub()
    const [echo] = await hub.resolve(['fixture/echo'])
    await hub.close() // kill the child under the tool's feet
    const dead = await echo!.execute({ text: 'x' })
    expect(dead.isError).toBe(true)
    const [echo2] = await hub.resolve(['fixture/echo']) // lazy respawn
    expect((await echo2!.execute({ text: 'back' })).isError).toBe(false)
  })
})
