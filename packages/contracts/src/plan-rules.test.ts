import { describe, expect, it } from 'bun:test'
import { PLAN_FIELD_RULES, planFieldViolations, RULE_SEVERITY, zoneEntryMisuse } from './plan-rules'

// pins the character set and the wording that teaches the fix
describe('zoneEntryMisuse', () => {
  const cases: [string, string, string][] = [
    ['a newline-joined entry — the observed failure', 'a/**\nb.ts', 'a/**\\nb.ts'],
    ['a carriage return', 'a/**\rb.ts', 'a/**\\rb.ts'],
    ['a tab', 'a/**\tb.ts', 'a/**\\tb.ts'],
    ['a NUL', 'a/**\0b.ts', 'a/**\\0b.ts'],
  ]

  for (const [label, entry, rendered] of cases)
    it(`rejects ${label}`, () => {
      const m = zoneEntryMisuse([entry])
      expect(m).toBeString()
      expect(m).toContain(rendered)          // visible escapes: two characters, not a line break
      expect(m).not.toContain(entry)         // the raw control character never reaches the message
      expect(m).toContain('one glob per array entry')
    })

  it('rejects an empty entry and a whitespace-only entry', () => {
    for (const entry of ['', '   ']) {
      const m = zoneEntryMisuse([entry])
      expect(m).toBeString()
      expect(m).toContain('one glob per array entry')
    }
    expect(zoneEntryMisuse(['   '])).toContain('"   "')
  })

  it('reports the FIRST offending entry only', () => {
    const m = zoneEntryMisuse(['ok/**', 'bad\none', 'worse\ttwo'])
    expect(m).toContain('bad\\none')
    expect(m).not.toContain('worse')
  })

  it('accepts ordinary globs', () => {
    expect(zoneEntryMisuse(['a/**', 'b.ts'])).toBeNull()
    expect(zoneEntryMisuse([])).toBeNull()
    expect(zoneEntryMisuse(['docs/**'])).toBeNull()
    // the characters a real glob is made of, none of them control characters
    expect(zoneEntryMisuse(['packages/*/src/**/*.{ts,tsx}', '!**/node_modules/**', 'a b/c.ts'])).toBeNull()
  })

  it('rejects the whole C0 range and DEL, not only the four named escapes', () => {
    for (const code of [0x01, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f])
      expect(zoneEntryMisuse([`a/${String.fromCharCode(code)}b`])).toBeString()
  })
})

const clean = { id: 'verify', zone: ['packages/**'] }

describe('planFieldViolations', () => {
  it('routes a zone misuse to shape with the pinned wording', () => {
    const v = planFieldViolations({ ...clean, zone: ['a/**\nb.ts'] })
    expect(v.shape).toHaveLength(1)
    expect(v.shape[0]).toContain('one glob per array entry')
    expect(v.shape[0]).toContain('\\n') // escapes rendered, not reproduced
    expect(v.judgment).toEqual([])
  })
  it('returns empty sets for a clean note', () => {
    expect(planFieldViolations(clean)).toEqual({ shape: [], judgment: [] })
  })
  it('every rule has a unique id and a declared severity', () => {
    expect(new Set(PLAN_FIELD_RULES.map(r => r.id)).size).toBe(PLAN_FIELD_RULES.length)
    for (const r of PLAN_FIELD_RULES) expect(Object.values(RULE_SEVERITY)).toContain(r.severity)
  })
})
