
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { isRecord } from '@orc/contracts'
import { asFetch, type MinimalFetch } from './fetch-shim'

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const OAUTH_BETA = 'oauth-2025-04-20'
const CRED_PATH = join(homedir(), '.claude', '.credentials.json')

// anything expiring within the buffer counts as expired: a token lapsing mid-request 401s
const EXPIRY_BUFFER_MS = 60_000

// .catch(undefined) per field: one corrupt field must not discard a good accessToken beside it
const OAuthCred = z.object({
  accessToken: z.string().optional().catch(undefined),
  expiresAt: z.number().optional().catch(undefined),
})
type OAuthCred = z.infer<typeof OAuthCred>

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
    oauth = isRecord(cred) ? OAuthCred.parse(cred) : undefined
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

const isSystemBlock = (v: unknown): v is SystemBlock => isRecord(v) && v.type === 'text' && typeof v.text === 'string'

// Returns unknown[]: elements pass through to the request body unfiltered
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
  return asFetch(wrapped)
}
