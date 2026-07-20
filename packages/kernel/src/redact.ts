// The ONE storage-boundary normalizer: strips NUL (Postgres jsonb rejects \u0000 inside
// strings, 22P05) and redacts secrets — once, at append/operation storage, after contract
// validation. Every projection downstream sees only redacted data.

// values under these keys are dropped wherever they appear (case/format-insensitive:
// apiKey, api_key, API-KEY all match)
// A bare 'token' suffix is NOT listed, deliberately: `runToken` normalizes to `runtoken`, which
// would match, and runToken is a required field in most PAYLOAD_SCHEMAS — which are validated
// AFTER redaction (event-log.ts), so every such event would fail to append. The token-shaped
// names below are enumerated instead. Secrets minted during a run (a tool returning a freshly
// created credential) are caught only by key, never by value: value-matching sees process.env.
const SENSITIVE_KEY_SUFFIXES = [
  'authorization', 'apikey', 'password', 'secret', 'privatekey', 'credentials', 'cookie',
  'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken', 'sessiontoken', 'apitoken', 'idtoken',
]

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replaceAll(/[-_]/g, '')
  return SENSITIVE_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

const SECRET_ENV_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/

// short values are not globally string-replaced — they would corrupt ordinary text
const MIN_SECRET_LENGTH = 8

export type Redactor = (record: Record<string, unknown>) => Record<string, unknown>

export function buildRedactor(env: Record<string, string | undefined>, extraNames: string[]): Redactor {
  const names = new Set([...Object.keys(env).filter(n => SECRET_ENV_RE.test(n)), ...extraNames])
  const secrets = [...names]
    .map(name => ({ name, value: env[name] ?? '' }))
    .filter(s => s.value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.value.length - a.value.length) // longest first: overlapping secrets redact fully

  const cleanString = (s: string): string => {
    let out = s.replaceAll('\u0000', '')
    for (const { name, value } of secrets) out = out.split(value).join(`[REDACTED:${name}]`)
    return out
  }

  // keys are cleaned too: a secret or NUL inside a JSON key (URL-keyed maps, header names)
  // must not reach storage any more than one inside a value
  const entry = ([k, v]: [string, unknown]): [string, unknown] =>
    [cleanString(k), isSensitiveKey(k) ? '[REDACTED]' : value(v)]

  const value = (v: unknown): unknown =>
    typeof v === 'string' ? cleanString(v)
    : Array.isArray(v) ? v.map(value)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(entry))
    : v

  return r => Object.fromEntries(Object.entries(r).map(entry))
}
