
// no bare 'token' suffix: runToken would match, and payloads validate after redaction
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

export interface Redactor {
  (record: Record<string, unknown>): Record<string, unknown>
  value<T>(v: T): T
}

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

  // JSON keys are cleaned too: URL-keyed maps and header names can carry secrets
  const entry = ([k, v]: [string, unknown]): [string, unknown] =>
    [cleanString(k), isSensitiveKey(k) ? '[REDACTED]' : value(v)]

  const value = (v: unknown): unknown =>
    typeof v === 'string' ? cleanString(v)
    : Array.isArray(v) ? v.map(value)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(entry))
    : v

  const redactor = (r: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(r).map(entry))
  // the walk is shape-preserving, so the cast is a fact the type system cannot follow
  return Object.assign(redactor, { value: <T>(v: T): T => value(v) as T })
}
