import { describe, expect, it } from 'bun:test'
import { siblingOrderingMisuse, zoneEntryMisuse } from './plan-ordering'
import { LINK_KIND } from './memory'

describe('siblingOrderingMisuse', () => {
  it('names the sibling edge and the field that actually orders', () => {
    const m = siblingOrderingMisuse('verify', [{ id: 'generate-doc', kind: LINK_KIND.depends_on }], ['generate-doc'])
    expect(m).toContain("plan-note 'verify' links depends_on 'generate-doc'")
    expect(m).toContain('FIELD, not a link')
  })

  it('says nothing about a depends_on link to a non-sibling, or any other kind', () => {
    expect(siblingOrderingMisuse('verify', [{ id: 'auth-flow', kind: LINK_KIND.depends_on }], ['generate-doc'])).toBeNull()
    expect(siblingOrderingMisuse('verify', [{ id: 'generate-doc', kind: LINK_KIND.refines }], ['generate-doc'])).toBeNull()
  })
})

// A planner froze a zone whose single entry was several globs joined with newlines
// (`["a/**\nb.ts"]`). Nothing refused it, the frozen fence then matched no real path, two steps were
// refused every write to their own files, and there was no repair path — a whole slice's pipeline
// was cancelled. These cases pin the character set and the wording that teaches the fix.
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
