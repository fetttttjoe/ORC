import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MemoryAuthor } from './author'
import { ClaimClass, EntityPath } from './claim'
import { ROOT_ENTITY } from './entity-of'

export const KNOWLEDGE_ID_LENGTH = 8
export const KNOWLEDGE_ID_RE = new RegExp(`^[a-z0-9]{${KNOWLEDGE_ID_LENGTH}}$`)
export const DECISION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const KNOWLEDGE_TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const GRAMMAR_BREAKERS = /[\s#@{}]/
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const KNOWLEDGE_LIMITS = {
  textChars: 1_000,
  whyChars: 1_000,
  anchors: 8,
  tags: 8,
  tagChars: 40,
  sources: 8,
  urlChars: 2_048,
  slugChars: 120,
  patchItems: 100,
  deliveredIds: 200,
  subjectChars: 300,
  pageItems: 100,
  searchItems: 50,
  bucketWarnClaims: 40,
} as const

const idFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes.subarray(0, KNOWLEDGE_ID_LENGTH), byte => ID_ALPHABET.charAt(byte % ID_ALPHABET.length)).join('')

export const newKnowledgeId = (): string => idFromBytes(randomBytes(KNOWLEDGE_ID_LENGTH))
export const knowledgeIdFrom = (seed: string): string => idFromBytes(createHash('sha256').update(seed).digest())

const grammarSafe = (value: string): boolean => !GRAMMAR_BREAKERS.test(value)

export const KnowledgeId = z.string().regex(KNOWLEDGE_ID_RE)
export const DecisionSlug = z.string().max(KNOWLEDGE_LIMITS.slugChars).regex(DECISION_SLUG_RE)
const Tag = z.string().max(KNOWLEDGE_LIMITS.tagChars).regex(KNOWLEDGE_TAG_RE)
const URL_BREAKERS = /[\s<>{}]/
export const SourceUrl = z.string().max(KNOWLEDGE_LIMITS.urlChars).refine(value => {
  if (URL_BREAKERS.test(value) || !URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
}, 'a source is a credential-free http(s) URL without spaces, <, >, { or }')

const ClaimText = z.string().trim().min(1).max(KNOWLEDGE_LIMITS.textChars)
  .refine(text => !/[\r\n]/.test(text), 'a claim is one line')
  .refine(text => !text.endsWith('}'), 'a claim cannot end with }')

export const KnowledgeAnchor = z.object({
  path: EntityPath
    .refine(path => path !== ROOT_ENTITY, 'an anchor path cannot be the root')
    .refine(grammarSafe, 'an anchor path cannot contain whitespace, #, @, { or }'),
  symbol: z.string().min(1).refine(grammarSafe, 'a symbol cannot contain whitespace, #, @, { or }').nullable().default(null),
})
export type KnowledgeAnchor = z.infer<typeof KnowledgeAnchor>

const Anchors = z.array(KnowledgeAnchor).max(KNOWLEDGE_LIMITS.anchors)
const Tags = z.array(Tag).max(KNOWLEDGE_LIMITS.tags)
const Sources = z.array(SourceUrl).max(KNOWLEDGE_LIMITS.sources)

export const KnowledgeDraft = z.object({
  text: ClaimText,
  class: z.enum(ClaimClass),
  anchors: Anchors.default([]),
  tags: Tags.default([]),
  sources: Sources.default([]),
  decision: DecisionSlug.nullable().default(null),
})
export type KnowledgeDraft = z.infer<typeof KnowledgeDraft>

export const KnowledgeAddition = KnowledgeDraft.extend({ id: KnowledgeId.optional() })
export type KnowledgeAddition = z.infer<typeof KnowledgeAddition>

export const KnowledgeClaim = KnowledgeDraft.extend({ id: KnowledgeId, location: z.string().min(1) })
export type KnowledgeClaim = z.infer<typeof KnowledgeClaim>

export const KnowledgeChange = z.object({
  id: KnowledgeId,
  text: ClaimText.optional(),
  class: z.enum(ClaimClass).optional(),
  anchors: Anchors.optional(),
  tags: Tags.optional(),
  sources: Sources.optional(),
  decision: DecisionSlug.nullable().optional(),
})
export type KnowledgeChange = z.infer<typeof KnowledgeChange>

export const KnowledgePatch = z.object({
  add: z.array(KnowledgeAddition).max(KNOWLEDGE_LIMITS.patchItems).default([]),
  change: z.array(KnowledgeChange).max(KNOWLEDGE_LIMITS.patchItems).default([]),
  retire: z.array(KnowledgeId).max(KNOWLEDGE_LIMITS.patchItems).default([]),
  why: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.whyChars).nullable().default(null),
  decision: DecisionSlug.nullable().default(null),
})
  .refine(p => p.add.length + p.change.length + p.retire.length > 0, 'a patch adds, changes or retires at least one claim')
  .refine(p => new Set(p.change.map(c => c.id)).size === p.change.length, 'a patch changes each claim at most once')
  .refine(p => new Set(p.retire).size === p.retire.length, 'a patch retires each claim at most once')
  .refine(p => !p.change.some(c => p.retire.includes(c.id)), 'a patch cannot change and retire the same claim')
  .refine(p => !p.add.some(a => a.id !== undefined && p.retire.includes(a.id)), 'a patch cannot add and retire the same claim')
  .refine(p => { const ids = p.add.flatMap(a => (a.id === undefined ? [] : [a.id])); return new Set(ids).size === ids.length }, 'a patch adds each claim at most once')
  .refine(p => !p.add.some(a => a.id !== undefined && p.change.some(c => c.id === a.id)), 'a patch cannot add and change the same claim')
export type KnowledgePatch = z.infer<typeof KnowledgePatch>
export type KnowledgePatchInput = z.input<typeof KnowledgePatch>

export const KnowledgeRef = z.object({ id: KnowledgeId, location: z.string().min(1) })
export type KnowledgeRef = z.infer<typeof KnowledgeRef>

export const KnowledgeWriteResult = z.object({
  added: z.array(KnowledgeRef),
  changed: z.array(KnowledgeRef),
  retired: z.array(KnowledgeRef),
  warnings: z.array(z.string()),
})
export type KnowledgeWriteResult = z.infer<typeof KnowledgeWriteResult>

export const KnowledgeProblem = z.object({
  location: z.string().min(1),
  line: z.number().int().nonnegative(),
  message: z.string().min(1),
})
export type KnowledgeProblem = z.infer<typeof KnowledgeProblem>

export const KnowledgePage = z.object({ cursor: z.string().nullable(), limit: z.number().int().positive() })
export type KnowledgePage = z.infer<typeof KnowledgePage>

export interface KnowledgeCard { entity: string; claims: KnowledgeClaim[]; next: string | null }
export interface KnowledgeFormatResult { formatted: string[]; problems: KnowledgeProblem[] }

export interface KnowledgeBackend {
  card(checkout: string, entity: string, page: KnowledgePage): Promise<KnowledgeCard>
  search(checkout: string, query: string, limit: number): Promise<KnowledgeClaim[]>
  get(checkout: string, ids: readonly string[]): Promise<KnowledgeClaim[]>
  write(checkout: string, patch: KnowledgePatch): Promise<KnowledgeWriteResult>
  check(checkout: string): Promise<KnowledgeProblem[]>
  format(checkout: string): Promise<KnowledgeFormatResult>
}

export enum DeliveryMode {
  preload = 'preload',
  card = 'card',
  search = 'search',
  get = 'get',
  push = 'push',
}

export interface KnowledgeCall { author: MemoryAuthor; idempotencyKey: string | null }
export interface KnowledgeRead extends KnowledgeCall { mode: DeliveryMode }

export interface KnowledgePort {
  card(call: KnowledgeRead, entity: string, page?: Partial<KnowledgePage>): Promise<KnowledgeCard>
  search(call: KnowledgeRead, query: string, limit?: number): Promise<KnowledgeClaim[]>
  get(call: KnowledgeRead, ids: readonly string[]): Promise<KnowledgeClaim[]>
  write(call: KnowledgeCall, patch: KnowledgePatchInput): Promise<KnowledgeWriteResult>
}

export interface KnowledgePlugin {
  id: string
  create(options: Record<string, unknown>): KnowledgeBackend
}

export const DEFAULT_KNOWLEDGE_PLUGIN = 'git-files'

export const KnowledgeConfig = z.strictObject({
  plugin: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
})
export type KnowledgeConfig = z.infer<typeof KnowledgeConfig>

const CHECK_HINT = 'run orc knowledge check'

export const KNOWLEDGE_REFUSAL = {
  unknownId: (id: string): string => `no claim '${id}' in this checkout — read it again before changing it`,
  notRetired: (id: string): string => `no claim '${id}' in this checkout — nothing retired`,
  missingAnchor: (path: string): string => `anchor '${path}' does not exist in this checkout`,
  outsideCheckout: (path: string): string => `anchor '${path}' resolves outside this checkout`,
  idClash: (id: string): string => `claim id '${id}' already holds different content`,
  duplicateId: (id: string): string => `claim id '${id}' is in more than one bucket — ${CHECK_HINT}, fix it, then write again`,
  bucketProblems: (location: string, count: number): string =>
    `'${location}' has ${count} problem(s) — ${CHECK_HINT}, fix them, then write again`,
  raced: (): string => 'the knowledge write kept racing with other writers — call again',
  missingCheckout: (dir: string): string => `checkout '${dir}' does not exist`,
} as const
