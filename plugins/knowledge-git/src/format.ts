export const ANCHOR_SIGIL = '@'
export const TAG_SIGIL = '#'
export const SYMBOL_SEPARATOR = '#'
export const DECISION_PREFIX = 'adr:'
export const SOURCE_OPEN = '<'
export const SOURCE_CLOSE = '>'

export interface LineAnchor { path: string; symbol: string | null }
export interface LineClaim { id: string | null; text: string; section: string; anchors: LineAnchor[]; tags: string[]; sources: string[]; decision: string | null }
export interface ParsedLine extends LineClaim { line: number }
export interface BucketProblem { line: number; message: string }
export interface ParsedBucket { title: string | null; claims: ParsedLine[]; problems: BucketProblem[] }
export interface SerializableClaim { id: string; text: string; section: string; anchors: readonly LineAnchor[]; tags: readonly string[]; sources: readonly string[]; decision: string | null }

const TITLE = /^# (.+)$/
const HEADING = /^## (.+)$/
const ITEM = /^- (.*)$/
const WITH_TAIL = /^(.*?)\s*\{([^{}]*)\}$/

type Tail = Pick<LineClaim, 'id' | 'anchors' | 'tags' | 'sources' | 'decision'>

function parseTail(tail: string): Tail | string {
  const out: Tail = { id: null, anchors: [], tags: [], sources: [], decision: null }
  for (const [index, token] of tail.trim().split(/\s+/).filter(t => t !== '').entries()) {
    if (token.startsWith(SOURCE_OPEN)) {
      if (!token.endsWith(SOURCE_CLOSE) || token.length <= SOURCE_OPEN.length + SOURCE_CLOSE.length) return `malformed source '${token}'`
      out.sources.push(token.slice(SOURCE_OPEN.length, -SOURCE_CLOSE.length))
    } else if (token.startsWith(ANCHOR_SIGIL)) {
      const body = token.slice(ANCHOR_SIGIL.length)
      const cut = body.indexOf(SYMBOL_SEPARATOR)
      const path = cut === -1 ? body : body.slice(0, cut)
      const symbol = cut === -1 ? null : body.slice(cut + SYMBOL_SEPARATOR.length)
      if (path === '' || symbol === '') return `malformed anchor '${token}'`
      out.anchors.push({ path, symbol })
    } else if (token.startsWith(TAG_SIGIL)) {
      if (token.length === TAG_SIGIL.length) return 'empty tag'
      out.tags.push(token.slice(TAG_SIGIL.length))
    } else if (token.startsWith(DECISION_PREFIX)) {
      if (out.decision !== null) return 'more than one decision'
      out.decision = token.slice(DECISION_PREFIX.length)
    } else if (index === 0) out.id = token
    else return `unexpected token '${token}'`
  }
  return out
}

export function parseBucket(text: string, headings: readonly string[]): ParsedBucket {
  const claims: ParsedLine[] = []
  const problems: BucketProblem[] = []
  let title: string | null = null
  let section: string | null = null
  let seenHeading = false
  for (const [index, raw] of text.split('\n').entries()) {
    const line = index + 1
    const content = raw.trimEnd()
    if (content.trim() === '') continue
    const titled = TITLE.exec(content)
    if (titled) {
      if (title === null && !seenHeading) title = titled[1].trim()
      else problems.push({ line, message: 'a bucket has one title, before its sections' })
      continue
    }
    const heading = HEADING.exec(content)
    if (heading) {
      seenHeading = true
      const name = heading[1].trim()
      section = headings.includes(name) ? name : null
      if (section === null) problems.push({ line, message: `unknown section '${name}' (expected ${headings.join(', ')})` })
      continue
    }
    const item = ITEM.exec(content)
    if (!item) { problems.push({ line, message: 'not a claim line — expected "- <text> {<id> …}"' }); continue }
    if (section === null) { problems.push({ line, message: 'a claim outside a known section' }); continue }
    const body = item[1].trim()
    const tailed = WITH_TAIL.exec(body)
    if (!tailed) { claims.push({ id: null, text: body, section, anchors: [], tags: [], sources: [], decision: null, line }); continue }
    const tail = parseTail(tailed[2])
    if (typeof tail === 'string') { problems.push({ line, message: tail }); continue }
    claims.push({ ...tail, text: tailed[1].trim(), section, line })
  }
  return { title, claims, problems }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const anchorToken = (anchor: LineAnchor): string =>
  `${ANCHOR_SIGIL}${anchor.path}${anchor.symbol === null ? '' : `${SYMBOL_SEPARATOR}${anchor.symbol}`}`
const sortKey = (claim: SerializableClaim): string => {
  const first = claim.anchors[0]
  return first === undefined ? '' : `${first.path}${SYMBOL_SEPARATOR}${first.symbol ?? ''}`
}

export function formatLine(claim: SerializableClaim): string {
  const tail = [
    claim.id,
    ...claim.anchors.map(anchorToken),
    ...[...claim.tags].sort(byCodeUnit).map(tag => `${TAG_SIGIL}${tag}`),
    ...claim.sources.map(source => `${SOURCE_OPEN}${source}${SOURCE_CLOSE}`),
    ...(claim.decision === null ? [] : [`${DECISION_PREFIX}${claim.decision}`]),
  ]
  return `- ${claim.text} {${tail.join(' ')}}`
}

export function serializeBucket(title: string, claims: readonly SerializableClaim[], headings: readonly string[]): string {
  const lines = [`# ${title}`]
  for (const heading of headings) {
    const inSection = claims.filter(c => c.section === heading)
      .sort((a, b) => byCodeUnit(sortKey(a), sortKey(b)) || byCodeUnit(a.id, b.id))
    if (inSection.length === 0) continue
    lines.push('', `## ${heading}`, ...inSection.map(formatLine))
  }
  return `${lines.join('\n')}\n`
}
