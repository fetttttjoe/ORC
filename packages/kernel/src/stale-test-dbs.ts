export const STALE_TEST_DB_MS = 60 * 60_000

export function testDbName(prefix: string, nowMs: number, rand: string): string {
  return `${prefix}${Math.floor(nowMs / 1000)}_${rand}`
}

const TIMESTAMP_PREFIX = /^(\d+)_/

export function staleTestDbs(names: readonly string[], prefix: string, nowMs: number): string[] {
  return names.filter(name => {
    if (!name.startsWith(prefix)) return false
    const match = TIMESTAMP_PREFIX.exec(name.slice(prefix.length))
    // no digits right after the prefix: the pre-sweep <prefix><rand> format, always a leftover
    if (!match) return true
    return nowMs - Number(match[1]) * 1000 > STALE_TEST_DB_MS
  })
}
