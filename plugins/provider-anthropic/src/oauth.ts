// Claude subscription (OAuth) auth — the same credential Claude Code uses.
//
// Anthropic accepts a Claude Pro/Max OAuth access token in place of an API key when the
// request carries `Authorization: Bearer <token>`, the `anthropic-beta: oauth-2025-04-20`
// flag, and the Claude Code identity as its first system block. The executor sends no system
// prompt, so all three are injected here via a custom fetch — the change never leaves this
// plugin.
//
// Opt-in only (see index.ts): the default provider still uses ANTHROPIC_API_KEY, so existing
// setups are unaffected. Note: driving the orchestrator's automated calls off a Claude
// *subscription* token may fall outside its terms vs. metered API billing — that is a usage
// decision, not a technical limit.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '@orc/contracts'

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const OAUTH_BETA = 'oauth-2025-04-20'
export const CRED_PATH = join(homedir(), '.claude', '.credentials.json')

// A usable bearer token: the CLAUDE_CODE_OAUTH_TOKEN env override wins (headless/CI, same var
// Claude Code honours), else Claude Code's on-disk credential store.
// ponytail: no token refresh — an expired token throws with the fix. Add refresh when the
// re-login prompt gets annoying (POST https://console.anthropic.com/v1/oauth/token with the
// stored refreshToken + Claude Code's public client_id, then persist the result).
// TOCTOU guard: a token that expires between this check and the request lands as a mid-request
// 401 — treat anything expiring within the buffer as already expired.
const EXPIRY_BUFFER_MS = 60_000

// the slice of ~/.claude/.credentials.json's claudeAiOauth that gates a request
type OAuthCred = { accessToken?: string; expiresAt?: number }

export async function loadOAuthToken(now: number = Date.now(), credPath: string = CRED_PATH): Promise<string> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (fromEnv) return fromEnv

  let raw: string
  try {
    raw = await readFile(credPath, 'utf8')
  } catch {
    throw new Error(
      `Anthropic OAuth selected but no token found: log in with Claude Code or set CLAUDE_CODE_OAUTH_TOKEN (${credPath} unreadable).`,
    )
  }
  let oauth: OAuthCred | undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const cred = isRecord(parsed) ? parsed.claudeAiOauth : undefined
    if (isRecord(cred)) {
      oauth = {
        accessToken: typeof cred.accessToken === 'string' ? cred.accessToken : undefined,
        expiresAt: typeof cred.expiresAt === 'number' ? cred.expiresAt : undefined,
      }
    }
  } catch {
    throw new Error(`Malformed JSON in ${credPath} — log in with Claude Code again.`)
  }
  if (!oauth?.accessToken) {
    throw new Error(`No claudeAiOauth.accessToken in ${credPath} — log in with Claude Code.`)
  }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now + EXPIRY_BUFFER_MS) {
    throw new Error('Claude Code OAuth token expired — run `claude` once to refresh it, or set CLAUDE_CODE_OAUTH_TOKEN.')
  }
  return oauth.accessToken
}

type SystemBlock = { type: 'text'; text: string }

// an Anthropic system block, recognised by shape at the boundary — no cast (repo rule: parse, don't assert)
const isSystemBlock = (v: unknown): v is SystemBlock => isRecord(v) && v.type === 'text' && typeof v.text === 'string'

// The OAuth beta rejects requests whose first system block is not the Claude Code identity.
// Normalise whatever the caller sent (nothing / string / block array) so that block leads.
// Returns unknown[], not SystemBlock[]: elements are never filtered or dereferenced by shape here
// — the sole caller (oauthFetch, below) assigns the result straight to json.system and
// JSON.stringifies it into the request body, so a SystemBlock[] return type would be an unchecked
// lie for any API-shaped-but-non-SystemBlock element the caller originally passed through.
export function prependClaudeCodeIdentity(system: unknown): unknown[] {
  const identity: SystemBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY }
  if (system == null || system === '') return [identity]
  if (typeof system === 'string') return [identity, { type: 'text', text: system }]
  if (Array.isArray(system)) {
    const first: unknown = system[0]
    if (isSystemBlock(first) && first.text === CLAUDE_CODE_IDENTITY) return system
    return [identity, ...system]
  }
  return [identity]
}

type MinimalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// Wraps the model's fetch: swap key auth for the OAuth bearer + beta flag, inject the identity
// system block. baseFetch is injectable for tests.
export function oauthFetch(getToken: () => Promise<string>, baseFetch: MinimalFetch = fetch): typeof fetch {
  const wrapped: MinimalFetch = async (input, init) => {
    const token = await getToken()
    const headers = new Headers(init?.headers)
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${token}`)
    const beta = headers.get('anthropic-beta')
    headers.set('anthropic-beta', beta ? `${beta},${OAUTH_BETA}` : OAUTH_BETA)

    let body = init?.body
    if (typeof body === 'string') {
      try {
        const json: unknown = JSON.parse(body)
        if (isRecord(json)) {
          json.system = prependClaudeCodeIdentity(json.system)
          body = JSON.stringify(json)
          headers.delete('content-length') // body length changed — let the runtime recompute it
        }
      } catch {
        // non-JSON body (shouldn't happen for the Messages API): leave untouched
      }
    }
    return baseFetch(input, { ...init, headers, body })
  }
  // createAnthropic's fetch type is the full global signature (incl. preconnect); the SDK only
  // ever invokes the call signature, so a noop preconnect satisfies the type honestly.
  return Object.assign(wrapped, { preconnect: () => {} })
}
