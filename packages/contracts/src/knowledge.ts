import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MemoryAuthor } from './author'
import type { AnchorReading, ClaimState } from './claim-state'
import { ClaimClass, EntityPath } from './claim'
import { ROOT_ENTITY } from './entity-of'
import type { Decision, DecisionDraft, DecisionFilter, DecisionInputRaw, DecisionWriteResult } from './decision'
import type { StructureProvider } from './structure'
import { DecisionSlug, KNOWLEDGE_ID_LENGTH, KNOWLEDGE_ID_RE, KNOWLEDGE_TAG_LIMITS, KnowledgeId, KnowledgeRef, KnowledgeTag } from './knowledge-ref'

export {
  DECISION_SLUG_CHARS, DECISION_SLUG_RE, DecisionSlug, KNOWLEDGE_ID_LENGTH, KNOWLEDGE_ID_RE, KNOWLEDGE_TAG_LIMITS, KNOWLEDGE_TAG_RE,
  KnowledgeId, KnowledgeRef, KnowledgeTag,
} from './knowledge-ref'

const GRAMMAR_BREAKERS = /[\s#@{}]/
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const PATCH_ITEMS = 100

export const KNOWLEDGE_LIMITS = {
  textChars: 1_000,
  whyChars: 1_000,
  anchors: 8,
  tags: KNOWLEDGE_TAG_LIMITS.items,
  tagChars: KNOWLEDGE_TAG_LIMITS.chars,
  sources: 8,
  urlChars: 2_048,
  patchItems: PATCH_ITEMS,
  assertedItems: 2 * PATCH_ITEMS,
  deliveredIds: 200,
  subjectChars: 300,
  pageItems: 100,
  searchItems: 50,
  bucketWarnClaims: 40,
  preloadQueryChars: 600,
} as const

export const KNOWLEDGE_DEFAULTS = { pageItems: 50, searchItems: 20 } as const

export enum KnowledgeToolName {
  card = 'knowledge_card',
  search = 'knowledge_search',
  write = 'knowledge_write',
  taskClaims = 'task_claims',
  decisionList = 'decision_list',
  decisionRead = 'decision_read',
  recordDecision = 'record_decision',
  check = 'knowledge_check',
}

const idFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes.subarray(0, KNOWLEDGE_ID_LENGTH), byte => ID_ALPHABET.charAt(byte % ID_ALPHABET.length)).join('')

export const newKnowledgeId = (): string => idFromBytes(randomBytes(KNOWLEDGE_ID_LENGTH))
export const knowledgeIdFrom = (seed: string): string => idFromBytes(createHash('sha256').update(seed).digest())

const grammarSafe = (value: string): boolean => !GRAMMAR_BREAKERS.test(value)

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
const Tags = z.array(KnowledgeTag).max(KNOWLEDGE_LIMITS.tags)
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

export const KnowledgeWriteResult = z.object({
  added: z.array(KnowledgeRef),
  changed: z.array(KnowledgeRef),
  retired: z.array(KnowledgeRef),
  warnings: z.array(z.string()),
  files: z.array(z.string()),
})
export type KnowledgeWriteResult = z.infer<typeof KnowledgeWriteResult>

export enum CheckVerdict { holds = 'holds', false = 'false', unknown = 'unknown' }

export enum AutoHealMode { off = 'off', draft = 'draft' }

export const DriftFilter = z.object({
  paths: z.array(EntityPath).max(KNOWLEDGE_LIMITS.patchItems).optional(),
  ids: z.array(KnowledgeId).max(KNOWLEDGE_LIMITS.patchItems).optional(),
})
export type DriftFilter = z.infer<typeof DriftFilter>
export type DriftFilterInput = z.input<typeof DriftFilter>

export interface ClaimReading { claim: KnowledgeClaim; basis: string | null; anchors: AnchorReading[] }
export type AnchorDrift = AnchorReading & { state: ClaimState }
export interface ClaimDrift { claim: KnowledgeClaim; state: ClaimState; basis: string | null; anchors: AnchorDrift[] }

const correctsClaim = (patch: KnowledgePatch, id: string): boolean => patch.retire.includes(id) || patch.change.some(c => c.id === id)

export const KnowledgeCheckFields = z.object({
  id: KnowledgeId,
  verdict: z.enum(CheckVerdict),
  why: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.whyChars),
  patch: KnowledgePatch.optional(),
})
const CHECK_FIELD = KnowledgeCheckFields.keyof().enum

export const KnowledgeCheckInput = KnowledgeCheckFields.check(ctx => {
  const { id, verdict, patch } = ctx.value
  if (verdict === CheckVerdict.false && (patch === undefined || !correctsClaim(patch, id)))
    ctx.issues.push({ code: 'custom', input: ctx.value, path: [CHECK_FIELD.patch], message: KNOWLEDGE_REFUSAL.checkNeedsPatch(id) })
  if (verdict !== CheckVerdict.false && patch !== undefined)
    ctx.issues.push({ code: 'custom', input: ctx.value, path: [CHECK_FIELD.patch], message: KNOWLEDGE_REFUSAL.checkTakesNoPatch(verdict) })
})
export type KnowledgeCheckInput = z.infer<typeof KnowledgeCheckInput>
export type KnowledgeCheckInputRaw = z.input<typeof KnowledgeCheckInput>

export interface KnowledgeCheckResult { verdict: CheckVerdict; written: KnowledgeWriteResult | null; warnings: string[] }

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

export interface DecisionBackend {
  decisions(checkout: string): Promise<Decision[]>
  decision(checkout: string, id: string): Promise<Decision | null>
  recordDecision(checkout: string, draft: DecisionDraft): Promise<DecisionWriteResult>
}

export interface KnowledgeBackend extends DecisionBackend {
  card(checkout: string, entity: string, page: KnowledgePage): Promise<KnowledgeCard>
  search(checkout: string, query: string, limit: number): Promise<KnowledgeClaim[]>
  get(checkout: string, ids: readonly string[]): Promise<KnowledgeClaim[]>
  write(checkout: string, patch: KnowledgePatch): Promise<KnowledgeWriteResult>
  check(checkout: string): Promise<KnowledgeProblem[]>
  format(checkout: string): Promise<KnowledgeFormatResult>
  readings(checkout: string, filter: DriftFilter): Promise<ClaimReading[]>
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

export enum PreloadArm { pushed = 'pushed', here = 'here', around = 'around', search = 'search' }

export const PreloadRequest = z.object({
  pushed: z.array(KnowledgeId).max(KNOWLEDGE_LIMITS.patchItems),
  paths: z.array(EntityPath).max(KNOWLEDGE_LIMITS.patchItems),
  query: z.string().max(KNOWLEDGE_LIMITS.preloadQueryChars),
  budget: z.number().int().nonnegative(),
})
export type PreloadRequest = z.infer<typeof PreloadRequest>

export interface PreloadedClaim { claim: KnowledgeClaim; state: ClaimState; arm: PreloadArm }

export interface DecisionPort {
  decisions(call: KnowledgeCall, filter?: DecisionFilter): Promise<Decision[]>
  decision(call: KnowledgeCall, id: string): Promise<Decision>
  recordDecision(call: KnowledgeCall, input: DecisionInputRaw): Promise<DecisionWriteResult>
}

export interface KnowledgePort extends DecisionPort {
  card(call: KnowledgeRead, entity: string, page?: Partial<KnowledgePage>): Promise<KnowledgeCard>
  search(call: KnowledgeRead, query: string, limit?: number): Promise<KnowledgeClaim[]>
  get(call: KnowledgeRead, ids: readonly string[]): Promise<KnowledgeClaim[]>
  write(call: KnowledgeCall, patch: KnowledgePatchInput): Promise<KnowledgeWriteResult>
  drift(call: KnowledgeCall, filter?: DriftFilterInput): Promise<ClaimDrift[]>
  check(call: KnowledgeCall, input: KnowledgeCheckInputRaw): Promise<KnowledgeCheckResult>
  preload(call: KnowledgeCall, request: z.input<typeof PreloadRequest>): Promise<PreloadedClaim[]>
}

export type KnowledgeAccess = { port: KnowledgePort } | { unavailable: string }

export interface KnowledgeHost { structure: StructureProvider }

export interface KnowledgePlugin {
  id: string
  create(options: Record<string, unknown>, host: KnowledgeHost): KnowledgeBackend
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
  off: (): string => 'knowledge is off for this project (.orc/config.json "knowledge": null)',
  unavailable: (reason: string): string => `knowledge unavailable: ${reason}`,
  unknownDecision: (slug: string): string => `no decision '${slug}' in this checkout — record it first, or drop the reference`,
  unknownSymbol: (path: string, symbol: string, closest: readonly string[]): string =>
    closest.length === 0
      ? `anchor '${path}' has no symbol '${symbol}' — the file defines no named symbols`
      : `anchor '${path}' has no symbol '${symbol}' — closest: ${closest.join(', ')}`,
  symbolUnsupported: (path: string): string => `anchor '${path}' cannot carry a symbol — its file type has no outline; anchor the file itself`,
  checkNeedsPatch: (id: string): string => `a false check of '${id}' needs the patch that retires or changes it`,
  checkTakesNoPatch: (verdict: string): string => `a ${verdict} check carries no patch — only a false check corrects the claim`,
} as const
