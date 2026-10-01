import { z } from 'zod'
import { trimEdges } from './ids'
import { DECISION_SLUG_CHARS, DECISION_SLUG_RE, DecisionSlug, KNOWLEDGE_TAG_LIMITS, KnowledgeTag } from './knowledge-ref'

export enum DecisionStatus { proposed = 'proposed', accepted = 'accepted', superseded = 'superseded', deprecated = 'deprecated' }
export const DECISION_STATUS = DecisionStatus
export const decisionStatusOf = (status: DecisionStatus | undefined): DecisionStatus => status ?? DecisionStatus.accepted

export enum AdrSection { context = 'Context', decision = 'Decision', consequences = 'Consequences', considered = 'Considered' }

export const DECISION_LIMITS = { titleChars: 200, sectionChars: 20_000, optionChars: 2_000, considered: 20, summaryChars: 300 } as const
const ADR_HEADING_PREFIX = '## '
const SLUG_JOINER = '-'
const noHeadingLine = (text: string): boolean => !text.split('\n').some(line => line.startsWith(ADR_HEADING_PREFIX))
const HEADING_MESSAGE = `a line may not start with '${ADR_HEADING_PREFIX}' — that is an ADR heading`

const DecisionTitle = z.string().trim().min(1).max(DECISION_LIMITS.titleChars).refine(t => !/[\r\n]/.test(t), 'a title is one line')
const Section = z.string().trim().min(1).max(DECISION_LIMITS.sectionChars).refine(noHeadingLine, HEADING_MESSAGE)
const ConsideredOption = z.string().trim().min(1).max(DECISION_LIMITS.optionChars).refine(noHeadingLine, HEADING_MESSAGE)
const Tags = z.array(KnowledgeTag).max(KNOWLEDGE_TAG_LIMITS.items)
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const RecordableStatus = z.enum(DecisionStatus).refine(s => s !== DecisionStatus.superseded, 'superseded is set by recording the decision that replaces it')

export const DecisionInput = z.object({
  title: DecisionTitle,
  context: Section,
  decision: Section,
  consequences: Section,
  considered: z.array(ConsideredOption).max(DECISION_LIMITS.considered).default([]),
  status: RecordableStatus.optional(),
  tags: Tags.default([]),
  supersedes: DecisionSlug.optional(),
})
export type DecisionInput = z.infer<typeof DecisionInput>
export type DecisionInputRaw = z.input<typeof DecisionInput>

export const DecisionDraft = z.object({
  id: DecisionSlug, title: DecisionTitle, status: z.enum(DecisionStatus), date: IsoDate, tags: Tags,
  supersedes: DecisionSlug.nullable(), context: Section, decision: Section, consequences: Section,
  considered: z.array(ConsideredOption).max(DECISION_LIMITS.considered),
})
export type DecisionDraft = z.infer<typeof DecisionDraft>

export const Decision = DecisionDraft.extend({ supersededBy: DecisionSlug.nullable(), location: z.string().min(1) })
export type Decision = z.infer<typeof Decision>

export const DecisionRef = z.object({ id: DecisionSlug, location: z.string().min(1) })
export type DecisionRef = z.infer<typeof DecisionRef>

export const DecisionFilter = z.object({ status: z.enum(DecisionStatus).optional() })
export type DecisionFilter = z.infer<typeof DecisionFilter>

export interface DecisionWriteResult { recorded: DecisionRef; superseded: DecisionRef | null; status: DecisionStatus; files: string[]; warnings: string[] }
export interface DecisionSummary { id: string; title: string; status: DecisionStatus; date: string; summary: string; supersedes: string | null; supersededBy: string | null }

export const DECISION_REFUSAL = {
  exists: (id: string): string => `decision '${id}' already exists — a changed decision is a supersession: record the new one with supersedes '${id}'`,
  noSuchDecision: (id: string): string => `no decision '${id}'`,
  alreadySuperseded: (id: string): string => `decision '${id}' is already superseded — supersede the decision that replaced it`,
  proposedSupersedes: (id: string): string => `decision '${id}' is proposed — only an accepted decision supersedes another`,
  noSlug: (title: string): string => `cannot derive a decision id from '${title}' — use latin letters or digits`,
} as const

export function decisionSlugOf(title: string): string {
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, SLUG_JOINER)
  const slug = trimEdges(trimEdges(collapsed, SLUG_JOINER).slice(0, DECISION_SLUG_CHARS), SLUG_JOINER)
  if (!DECISION_SLUG_RE.test(slug)) throw new Error(DECISION_REFUSAL.noSlug(title))
  return slug
}

const RUNG: Record<DecisionStatus, number> = {
  [DecisionStatus.proposed]: 0, [DecisionStatus.accepted]: 1, [DecisionStatus.deprecated]: 2, [DecisionStatus.superseded]: 3,
}
export const byAttention = (a: Decision, b: Decision): number =>
  RUNG[a.status] - RUNG[b.status] || b.date.localeCompare(a.date) || a.id.localeCompare(b.id)

export function clipLine(text: string, maxChars: number): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  return first.length <= maxChars ? first : `${first.slice(0, Math.max(0, maxChars - 1))}…`
}

export const decisionSummaryOf = (d: Decision): DecisionSummary => {
  return { id: d.id, title: d.title, status: d.status, date: d.date, summary: clipLine(d.decision, DECISION_LIMITS.summaryChars), supersedes: d.supersedes, supersededBy: d.supersededBy }
}
