import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { listAnthropicModels } from './index'

// listModels contract (packages/contracts/src/execution.ts): REJECT when the API cannot answer;
// [] is reserved for "answered, nothing usable". The cost-table union lives in discovery
// (modelUniverse), not here — the served claude set survives an offline API either way, but
// `reachable` must stop lying about it.
describe('listAnthropicModels', () => {
  const KEYS = ['ORC_ANTHROPIC_AUTH', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    process.env.ORC_ANTHROPIC_AUTH = 'apikey' // pin the auth path: the host env may carry an OAuth token
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('parses the models API shape', async () => {
    const models = await listAnthropicModels(async () =>
      Response.json({ data: [{ id: 'claude-x-1' }, { id: 'claude-y-2' }, { broken: true }] }))
    expect(models).toEqual(['claude-x-1', 'claude-y-2'])
  })

  it('THROWS when the API cannot answer — [] is reserved for "answered, nothing usable"', async () => {
    await expect(listAnthropicModels(async () => { throw new Error('offline') })).rejects.toThrow()
    await expect(listAnthropicModels(async () => new Response('busy', { status: 529 }))).rejects.toThrow('529')
    await expect(listAnthropicModels(async () => new Response('<html>oops</html>'))).rejects.toThrow()
    await expect(listAnthropicModels(async () => Response.json({ nope: true }))).rejects.toThrow('data')
  })

  it('THROWS when no API key is set on the apikey path — cannot ask is not an empty catalog', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(listAnthropicModels(async () => Response.json({ data: [] }))).rejects.toThrow('ANTHROPIC_API_KEY')
  })

  it('an empty answer is a POSITIVE empty list — discovery unions the cost-table ids, not here', async () => {
    expect(await listAnthropicModels(async () => Response.json({ data: [] }))).toEqual([])
  })
})
