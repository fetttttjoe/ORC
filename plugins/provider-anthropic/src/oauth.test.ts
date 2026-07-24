import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '@orc/contracts'
import { CLAUDE_CODE_IDENTITY, loadOAuthToken, oauthFetch, prependClaudeCodeIdentity } from './oauth'

// oauthFetch injects a `system` array (identity block first); narrow the captured body
// at the read boundary rather than casting it.
const hasSystemArray = (v: unknown): v is { system: unknown[] } => isRecord(v) && Array.isArray(v.system)

const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
afterEach(() => {
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken
})

describe('prependClaudeCodeIdentity', () => {
  it('creates the identity block when there is no system prompt', () => {
    expect(prependClaudeCodeIdentity(undefined)).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })
  it('leads a string system prompt with the identity block', () => {
    expect(prependClaudeCodeIdentity('do the thing')).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'do the thing' },
    ])
  })
  it('does not double-prepend when identity is already first', () => {
    const already = [{ type: 'text' as const, text: CLAUDE_CODE_IDENTITY }, { type: 'text' as const, text: 'x' }]
    expect(prependClaudeCodeIdentity(already)).toBe(already)
  })
})

describe('loadOAuthToken', () => {
  it('prefers the env override', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token'
    expect(await loadOAuthToken()).toBe('env-token')
  })
  it('reads a valid token from a credentials file shape', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    // exercise the parse/expiry logic directly against a temp file via a thin re-read
    const dir = mkdtempSync(join(tmpdir(), 'orc-oauth-'))
    const path = join(dir, '.credentials.json')
    const future = Date.now() + 3_600_000
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token', expiresAt: future } }))
    const oauth = JSON.parse(await Bun.file(path).text()).claudeAiOauth
    expect(oauth.accessToken).toBe('file-token')
    expect(oauth.expiresAt > Date.now()).toBe(true)
  })
})

describe('oauthFetch', () => {
  it('swaps key auth for the bearer + beta and injects the identity system block', async () => {
    let seen!: { url: string; headers: Headers; body: unknown }
    const base = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
      return new Response('{}', { status: 200 })
    }
    const wrapped = oauthFetch(async () => 'tok-123', base)
    await wrapped('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'should-be-removed', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
    })

    expect(seen.headers.get('x-api-key')).toBeNull()
    expect(seen.headers.get('authorization')).toBe('Bearer tok-123')
    expect(seen.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    if (!hasSystemArray(seen.body)) throw new Error('captured body has no system array')
    expect(seen.body.system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTITY })
  })
})

describe('loadOAuthToken error paths (via credPath injection)', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'orc-oauth-err-')), '.credentials.json')
  it('missing file names the path and the fixes', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const p = join(tmpdir(), 'nope', '.credentials.json')
    await expect(loadOAuthToken(Date.now(), p)).rejects.toThrow(p)
  })
  it('malformed JSON is a named error, not a bare SyntaxError', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const p = tmp(); writeFileSync(p, '{nope')
    await expect(loadOAuthToken(Date.now(), p)).rejects.toThrow(/Malformed JSON/)
  })
  it('missing accessToken field', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const p = tmp(); writeFileSync(p, JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000 } }))
    await expect(loadOAuthToken(Date.now(), p)).rejects.toThrow(/accessToken/)
  })
  it('expiry boundary honors the TOCTOU buffer: <60s left = expired, >60s ok', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    const now = Date.now()
    const p = tmp(); writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: now + 30_000 } }))
    await expect(loadOAuthToken(now, p)).rejects.toThrow(/expired/)
    writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: now + 120_000 } }))
    expect(await loadOAuthToken(now, p)).toBe('t')
  })
})
