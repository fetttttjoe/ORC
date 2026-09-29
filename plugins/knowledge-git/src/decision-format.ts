export interface DecisionHeadings { context: string; decision: string; consequences: string; considered: string }
export interface DecisionFile {
  title: string; status: string; tags: string[]; supersedes: string | null; supersededBy: string | null
  context: string; decision: string; consequences: string; considered: string[]
}
export interface DecisionName { date: string; id: string }
export interface DecisionFileProblem { line: number; message: string }
export type DecisionLines = ReadonlyMap<keyof DecisionFile, number>
export enum FrontKey { status = 'status', tags = 'tags', supersedes = 'supersedes', supersededBy = 'supersededBy' }

export const DECISION_FILE_SUFFIX = '.md'
const FENCE = '---'
const TITLE_PREFIX = '# '
const H2 = '## '
const BULLET = '- '
const INDENT = '  '
const KEY_SEPARATOR = ': '
const TAG_SEPARATOR = ', '
const NAME = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\\${DECISION_FILE_SUFFIX}$`)
const FRONT_LINE = /^([A-Za-z]+): (.+)$/
const FRONT_KEYS: readonly FrontKey[] = Object.values(FrontKey)
const TITLE_FIELD = 'title' satisfies keyof DecisionFile
const PROSE_FIELDS = ['context', 'decision', 'consequences'] as const satisfies readonly (keyof DecisionHeadings & keyof DecisionFile)[]
const OPTIONS_FIELD = 'considered' satisfies keyof DecisionHeadings & keyof DecisionFile
const SECTION_FIELDS = [...PROSE_FIELDS, OPTIONS_FIELD] as const
type ProseField = (typeof PROSE_FIELDS)[number]

export const DECISION_FORMAT_PROBLEM = {
  noOpening: (): string => `a decision file starts with a '${FENCE}' line`,
  noClosing: (): string => `the frontmatter has no closing '${FENCE}'`,
  notKeyValue: (): string => `a frontmatter line is 'key${KEY_SEPARATOR}value'`,
  unknownKey: (key: string): string => `unknown frontmatter key '${key}' (known: ${FRONT_KEYS.join(', ')})`,
  repeatedKey: (key: string): string => `frontmatter key '${key}' appears twice`,
  noStatus: (): string => `the frontmatter has no ${FrontKey.status}`,
  noTitle: (): string => `no '${TITLE_PREFIX}' title after the frontmatter`,
  secondTitle: (): string => `a decision file has one '${TITLE_PREFIX}' title`,
  textBeforeSections: (): string => 'text between the title and the first section',
  unexpectedSection: (name: string, expected: readonly string[]): string =>
    `section '${name}' is out of place (expected ${expected.slice(0, -1).join(', ')}, then optionally ${expected.at(-1)})`,
  missingSection: (name: string): string => `missing section '${name}'`,
  emptySection: (name: string): string => `section '${name}' is empty`,
  notAnOption: (name: string): string => `the ${name} section starts with a line that is not a '${BULLET}' option`,
  headingInSection: (name: string): string =>
    `the ${name} section contains a line starting with '${H2}' — that is an ADR heading and cannot round-trip`,
} as const

export const decisionFileName = (date: string, id: string): string => `${date}-${id}${DECISION_FILE_SUFFIX}`

export function parseDecisionName(name: string): DecisionName | null {
  const match = NAME.exec(name)
  return match ? { date: match[1], id: match[2] } : null
}

const renderConsidered = (options: readonly string[]): string =>
  options.map(o => o.split('\n').map((line, i) => (i === 0 ? `${BULLET}${line}` : `${INDENT}${line}`)).join('\n')).join('\n')

const parseConsidered = (text: string): string[] => {
  const options: string[][] = []
  for (const line of text.split('\n')) {
    const open = options.at(-1)
    if (open === undefined || line.startsWith(BULLET)) options.push([line.startsWith(BULLET) ? line.slice(BULLET.length) : line])
    else open.push(line.startsWith(INDENT) ? line.slice(INDENT.length) : line)
  }
  return options.map(o => o.join('\n').trim())
}

export function renderDecision(file: DecisionFile, headings: DecisionHeadings): string {
  const front: Record<FrontKey, string | null> = {
    [FrontKey.status]: file.status,
    [FrontKey.tags]: file.tags.length === 0 ? null : file.tags.join(TAG_SEPARATOR),
    [FrontKey.supersedes]: file.supersedes,
    [FrontKey.supersededBy]: file.supersededBy,
  }
  const sections: [string, string][] = PROSE_FIELDS.map(field => [headings[field], file[field]])
  if (file[OPTIONS_FIELD].length > 0) sections.push([headings[OPTIONS_FIELD], renderConsidered(file[OPTIONS_FIELD])])
  for (const [name, text] of sections)
    if (text.split('\n').some(line => line.startsWith(H2))) throw new Error(DECISION_FORMAT_PROBLEM.headingInSection(name))
  return [
    FENCE,
    ...Object.values(FrontKey).flatMap(key => { const value = front[key]; return value === null ? [] : [`${key}${KEY_SEPARATOR}${value}`] }),
    FENCE,
    '',
    `${TITLE_PREFIX}${file.title}`,
    '',
    sections.map(([name, text]) => `${H2}${name}\n\n${text.trim()}\n`).join('\n'),
  ].join('\n')
}

type Parsed = { file: DecisionFile; lines: DecisionLines } | { problem: DecisionFileProblem }

const problem = (line: number, message: string): Parsed => ({ problem: { line, message } })

export function parseDecision(text: string, headings: DecisionHeadings): Parsed {
  const raw = text.split('\n')
  const rows = raw.map(line => line.trimEnd())
  const lastLine = text.endsWith('\n') ? raw.length - 1 : raw.length
  if (rows[0] !== FENCE) return problem(1, DECISION_FORMAT_PROBLEM.noOpening())
  const close = rows.indexOf(FENCE, 1)
  if (close === -1) return problem(1, DECISION_FORMAT_PROBLEM.noClosing())
  const front = new Map<FrontKey, string>()
  const lines = new Map<keyof DecisionFile, number>()
  for (let i = 1; i < close; i++) {
    const pair = FRONT_LINE.exec(rows[i])
    if (!pair) return problem(i + 1, DECISION_FORMAT_PROBLEM.notKeyValue())
    const key = FRONT_KEYS.find(known => known === pair[1])
    if (key === undefined) return problem(i + 1, DECISION_FORMAT_PROBLEM.unknownKey(pair[1]))
    if (front.has(key)) return problem(i + 1, DECISION_FORMAT_PROBLEM.repeatedKey(key))
    front.set(key, pair[2].trim())
    lines.set(key, i + 1)
  }
  const status = front.get(FrontKey.status)
  if (status === undefined) return problem(close + 1, DECISION_FORMAT_PROBLEM.noStatus())

  let at = close + 1
  while (at < rows.length && rows[at] === '') at++
  if (at === rows.length || !rows[at].startsWith(TITLE_PREFIX)) return problem(Math.min(at + 1, lastLine), DECISION_FORMAT_PROBLEM.noTitle())
  lines.set(TITLE_FIELD, at + 1)
  const marks = rows.flatMap((row, i) => (i > at && row.startsWith(H2) ? [i] : []))
  for (let i = at + 1; i < (marks[0] ?? rows.length); i++) {
    if (rows[i] === '') continue
    return problem(i + 1, rows[i].startsWith(TITLE_PREFIX) ? DECISION_FORMAT_PROBLEM.secondTitle() : DECISION_FORMAT_PROBLEM.textBeforeSections())
  }

  const order = SECTION_FIELDS.map(field => headings[field])
  const texts: string[] = []
  for (const [k, mark] of marks.entries()) {
    const name = rows[mark].slice(H2.length).trim()
    if (name !== order[k]) return problem(mark + 1, DECISION_FORMAT_PROBLEM.unexpectedSection(name, order))
    const body = raw.slice(mark + 1, marks[k + 1] ?? raw.length).join('\n').trim()
    if (body === '') return problem(mark + 1, DECISION_FORMAT_PROBLEM.emptySection(name))
    if (SECTION_FIELDS[k] === OPTIONS_FIELD && !body.startsWith(BULLET))
      return problem(rows.findIndex((row, i) => i > mark && row !== '') + 1, DECISION_FORMAT_PROBLEM.notAnOption(name))
    texts.push(body)
    lines.set(SECTION_FIELDS[k], mark + 1)
  }
  if (marks.length < PROSE_FIELDS.length) return problem(lastLine, DECISION_FORMAT_PROBLEM.missingSection(order[marks.length]))

  const prose = (field: ProseField): string => texts[PROSE_FIELDS.indexOf(field)]
  const tags = front.get(FrontKey.tags)
  return {
    file: {
      title: rows[at].slice(TITLE_PREFIX.length).trim(),
      status,
      tags: tags === undefined ? [] : tags.split(TAG_SEPARATOR.trim()).map(tag => tag.trim()),
      supersedes: front.get(FrontKey.supersedes) ?? null,
      supersededBy: front.get(FrontKey.supersededBy) ?? null,
      context: prose('context'), decision: prose('decision'), consequences: prose('consequences'),
      considered: texts.length > PROSE_FIELDS.length ? parseConsidered(texts[PROSE_FIELDS.length]) : [],
    },
    lines,
  }
}
