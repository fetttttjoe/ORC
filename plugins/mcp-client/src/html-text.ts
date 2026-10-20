// Shared by the `fetch` tool (whole pages) and the Wikipedia backend (snippets).

const NON_PROSE = 'script, style, noscript, template, textarea, svg'

// Not a full entity table: an unresolved `&eacute;` still reads
const NAMED_REF: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decodeRefs = (s: string): string =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = Number(ref[1] === 'x' || ref[1] === 'X' ? `0${ref.slice(1)}` : ref.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_REF[ref.toLowerCase()] ?? whole
  })

// A parser, not a regex: `<[^>]+>` stops at the `>` inside an attribute value
export async function stripHtml(html: string): Promise<string> {
  const chunks: string[] = []
  let insideNonProse = 0
  await new HTMLRewriter()
    .on(NON_PROSE, { element(el) { insideNonProse++; el.onEndTag(() => { insideNonProse-- }) } })
    // onDocument, not .on('*'): '*' never sees text outside an element, e.g. a bare search snippet
    .onDocument({ text(t) { if (insideNonProse === 0) chunks.push(t.text) } })
    .transform(new Response(html))
    .text()
  return decodeRefs(chunks.join(' ')).replace(/\s+/g, ' ').trim()
}
