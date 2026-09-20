import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { OpenAIAuth, type OpenAIOptions } from './options'

const CodexCredentials = z.object({
  auth_mode: z.literal('chatgpt'),
  tokens: z.object({ access_token: z.string().min(1), account_id: z.string().min(1) }),
})
const TokenExpiry = z.object({ exp: z.number() })

export async function credentialHeaders(options: OpenAIOptions): Promise<Headers> {
  const headers = new Headers()
  if (options.auth === OpenAIAuth.none) return headers
  if (options.auth === OpenAIAuth.apiKey) {
    const key = process.env[options.apiKeyEnv]
    if (!key) throw new Error(`${options.apiKeyEnv} is not set — cannot call the OpenAI-compatible provider`)
    headers.set('authorization', `Bearer ${key}`)
    return headers
  }
  const file = join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  let credentials: z.infer<typeof CodexCredentials>
  try {
    credentials = CodexCredentials.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    throw new Error('Codex ChatGPT credentials are unavailable or invalid — run codex login with file-based credential storage')
  }
  const { access_token: token, account_id: account } = credentials.tokens
  const payload = token.split('.')[1]
  if (payload) {
    const expiry = TokenExpiry.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    if (expiry.success && expiry.data.exp * 1000 <= Date.now())
      throw new Error('Codex login expired — run Codex to refresh it, then retry')
  }
  headers.set('authorization', `Bearer ${token}`)
  headers.set('ChatGPT-Account-Id', account)
  return headers
}
