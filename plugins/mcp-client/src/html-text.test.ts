import { describe, expect, it } from 'bun:test'
import { stripHtml } from './html-text'

// Were assertions behind a `--selftest` flag CI never invoked.
describe('stripHtml', () => {
  it('keeps prose and drops the markup around it', async () => {
    expect(await stripHtml('<b>Event</b> <span class="x">sourcing</span>')).toBe('Event sourcing')
  })

  it('drops the body of non-prose elements, including a spaced end tag', async () => {
    expect(await stripHtml('a<script>evil()</script>b')).toBe('a b')
    expect(await stripHtml('a<script>evil()</script >b')).toBe('a b')
    expect(await stripHtml('a<style>.x{}</style>b')).toBe('a b')
  })

  // the three the previous regex got wrong
  it("does not leak an attribute's own '>' into the text", async () => {
    expect(await stripHtml('<div data-x="a>b">text</div>')).toBe('text')
  })

  it('drops comments whole rather than leaking their delimiters', async () => {
    expect(await stripHtml('a<!-- hidden <b>x</b> -->b')).toBe('a b')
  })

  it('decodes the references it knows and preserves the rest instead of deleting them', async () => {
    expect(await stripHtml('caf&eacute; &amp; cr&egrave;me')).toBe('caf&eacute; & cr&egrave;me')
    expect(await stripHtml('&#65;&#x42;')).toBe('AB')
    expect(await stripHtml('a&nbsp;b')).toBe('a b')
  })

  it('keeps text that sits outside any element', async () => {
    expect(await stripHtml('plain text')).toBe('plain text')
    expect(await stripHtml('<span class="searchmatch">event</span> sourcing')).toBe('event sourcing')
  })
})
