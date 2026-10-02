import { describe, expect, it } from 'bun:test'
import { sha256, type Outline, type SymbolSpan } from '@orc/contracts'
import { digestIn, directoryDigest, GONE, readingOf, sourceView, textOf, UNREADABLE } from './anchor-digest'

const span = (name: string, digest: string): SymbolSpan => ({ name, kind: 'function_declaration', startLine: 1, endLine: 1, digest })
const raw = (text: string): Uint8Array => Buffer.from(text, 'utf8')
const outline = (symbols: SymbolSpan[], partial = false): Outline => ({ digest: 'file-tokens', symbols, partial })

describe('digestIn', () => {
  it('a file anchor reads the outline digest, or the raw bytes when the file has no outline', () => {
    expect(digestIn(sourceView(raw('{ "a": 1 }'), outline([])), null)).toEqual({ digest: 'file-tokens', readable: true })
    expect(digestIn(sourceView(raw('{ "a": 1 }'), null), null)).toEqual({ digest: sha256('{ "a": 1 }'), readable: true })
  })

  it('an outline-less file is digested by its bytes, so two byte sequences that decode alike still differ', () => {
    const [one, two] = [Uint8Array.of(0x7b, 0x80, 0x7d), Uint8Array.of(0x7b, 0x81, 0x7d)]
    expect(textOf(one)).toBe(textOf(two))
    expect(digestIn(sourceView(one, null), null).digest).not.toBe(digestIn(sourceView(two, null), null).digest)
  })

  it('decoding keeps a byte-order mark, as reading a file as utf8 does', () => {
    expect(textOf(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d))).toBe('\uFEFF{}')
  })

  it('a symbol that occurs more than once digests every span in source order', () => {
    const twice = outline([span('x', 'd1'), span('y', 'dy'), span('x', 'd2')])
    expect(digestIn(sourceView(raw(''), twice), 'x')).toEqual({ digest: sha256('d1 d2'), readable: true })
    expect(digestIn(sourceView(raw(''), outline([span('x', 'd1'), span('x', 'd3')])), 'x').digest).not.toBe(sha256('d1 d2'))
  })

  it('a unique short form reads its full name', () => {
    expect(digestIn(sourceView(raw(''), outline([span('outer.inner', 'di')])), 'inner')).toEqual({ digest: sha256('di'), readable: true })
  })

  it('a missing symbol is gone in a whole outline and unreadable in a partial one; a file with no outline cannot carry one', () => {
    expect(digestIn(sourceView(raw(''), outline([span('x', 'd1')])), 'gone')).toEqual(GONE)
    expect(digestIn(sourceView(raw(''), outline([span('x', 'd1')], true)), 'gone')).toEqual(UNREADABLE)
    expect(digestIn(sourceView(raw(''), outline([span('x', 'd1')], true)), 'x')).toEqual({ digest: sha256('d1'), readable: true })
    expect(digestIn(sourceView(raw('{}'), null), 'name')).toEqual(UNREADABLE)
  })
})

describe('directoryDigest', () => {
  it('depends on the set of paths, not their order', () => {
    expect(directoryDigest(['pkg/b.ts', 'pkg/a.ts'])).toBe(directoryDigest(['pkg/a.ts', 'pkg/b.ts']))
    expect(directoryDigest(['pkg/a.ts'])).not.toBe(directoryDigest(['pkg/a.ts', 'pkg/b.ts']))
  })
})

describe('readingOf', () => {
  const anchor = { path: 'src/a.ts', symbol: 'alpha' }
  const seen = { digest: 'd1', readable: true }
  it('is readable only when both its basis and its current digest are', () => {
    expect(readingOf(anchor, seen, seen)).toEqual({ path: 'src/a.ts', symbol: 'alpha', basis: 'd1', current: 'd1', readable: true })
    expect(readingOf(anchor, UNREADABLE, seen).readable).toBe(false)
    expect(readingOf(anchor, seen, UNREADABLE).readable).toBe(false)
    expect(readingOf(anchor, GONE, seen).readable).toBe(true)
  })
})
