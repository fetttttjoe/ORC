import { describe, expect, it } from 'bun:test'
import { STALE_TEST_DB_MS, staleTestDbs, testDbName } from './stale-test-dbs'

describe('testDbName', () => {
  it('joins prefix, floored unix seconds and rand with underscores', () => {
    expect(testDbName('orc_test_', 1_758_431_673_000, 'ab12cd34')).toBe('orc_test_1758431673_ab12cd34')
  })

  it('floors sub-second precision to the same second', () => {
    expect(testDbName('orc_test_', 1_758_431_673_999, 'ab12cd34')).toBe('orc_test_1758431673_ab12cd34')
  })

  it('carries a different prefix through unchanged', () => {
    expect(testDbName('t_', 1_758_431_673_000, 'ab12cd34')).toBe('t_1758431673_ab12cd34')
  })
})

describe('staleTestDbs', () => {
  const NOW = 1_758_431_673_000
  const HOUR = 60 * 60_000
  const agedName = (prefix: string, ageMs: number, suffix = '') =>
    `${testDbName(prefix, NOW - ageMs, 'ab12cd34')}${suffix}`

  const cases: { name: string; stale: boolean }[] = [
    { name: 'orc_test_ab12cd34', stale: true }, // pre-sweep format, no timestamp: always a leftover
    { name: 'orc_test_12ab34cd', stale: true }, // rand starting with digits still has no ts + '_'
    { name: 'orc_test_ab12cd34_dbos_sys', stale: true }, // old-format derived twin follows its parent
    { name: agedName('orc_test_', 60_000), stale: false }, // one minute old: fresh
    { name: agedName('orc_test_', HOUR), stale: false }, // exactly STALE_TEST_DB_MS: still within the window
    { name: agedName('orc_test_', HOUR + 1_000), stale: true }, // one second past the window
    { name: agedName('orc_test_', 2 * HOUR), stale: true }, // well past the window
    { name: agedName('orc_test_', 60_000, '_dbos_sys'), stale: false }, // derived twin of a fresh parent
    { name: agedName('orc_test_', 2 * HOUR, '_dbos_sys'), stale: true }, // derived twin of a stale parent
    { name: agedName('t_', 2 * HOUR), stale: false }, // different prefix: never returned by this sweep
  ]

  it('classifies each name correctly against a fixed clock', () => {
    for (const { name, stale } of cases)
      expect({ name, stale: staleTestDbs([name], 'orc_test_', NOW).includes(name) }).toEqual({ name, stale })
  })

  it('returns exactly the stale subset from one mixed list', () => {
    const names = cases.map(c => c.name)
    const expected = cases.filter(c => c.stale && c.name.startsWith('orc_test_')).map(c => c.name)
    expect(staleTestDbs(names, 'orc_test_', NOW).sort()).toEqual(expected.sort())
  })

  it('STALE_TEST_DB_MS is one hour', () => {
    expect(STALE_TEST_DB_MS).toBe(60 * 60_000)
  })
})
