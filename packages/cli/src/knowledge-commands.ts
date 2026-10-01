import { Command } from 'commander'
import {
  AUTHOR_SOURCE, ClaimClass, ClaimState, Door, KNOWLEDGE_DEFAULTS, KnowledgePatch, NO_CHAT,
  type ClaimDrift, type KnowledgeAccess, type KnowledgeClaim, type KnowledgeProblem, type MemoryAuthor,
} from '@orc/contracts'
import type { EventLog, Kernel, ProjectConfig } from '@orc/kernel'
import { cwdAuthor, type WorkspaceFold } from './cwd-workspace'
import { enumArg } from './enum-arg'
import { parsePositiveInteger } from './int-arg'
import { CommandFailure } from './exit'
import { knowledgeAccess, openKnowledge, type KnowledgeOpening } from './knowledge-open'

export const KNOWLEDGE_SUBCOMMAND = { card: 'card', search: 'search', add: 'add', retire: 'retire', fmt: 'fmt', check: 'check', drift: 'drift' } as const
export const NO_PROJECT_CONTEXT = 'knowledge commands need a project context'
export const ANCHOR_ARG_SEPARATOR = '#'
const parseClass = enumArg<ClaimClass>('class', Object.values(ClaimClass))

export function parseAnchorArg(value: string): { path: string; symbol: string | null } {
  const cut = value.indexOf(ANCHOR_ARG_SEPARATOR)
  return cut === -1 ? { path: value, symbol: null } : { path: value.slice(0, cut), symbol: value.slice(cut + ANCHOR_ARG_SEPARATOR.length) }
}

export function renderClaims(claims: readonly KnowledgeClaim[]): string[] {
  if (claims.length === 0) return ['_no claims_']
  return claims.map(c => [
    `[${c.id}] ${c.class}: ${c.text}`,
    ...(c.anchors.length === 0 ? [] : [`← ${c.anchors.map(a => (a.symbol === null ? a.path : `${a.path} ${a.symbol}`)).join(', ')}`]),
    ...(c.tags.length === 0 ? [] : [`tags: ${c.tags.join(', ')}`]),
    ...(c.sources.length === 0 ? [] : [`sources: ${c.sources.join(', ')}`]),
    ...(c.decision === null ? [] : [`decision: ${c.decision}`]),
    `(${c.location})`,
  ].join('  '))
}

export const renderProblems = (problems: readonly KnowledgeProblem[]): string[] =>
  problems.map(p => `${p.location}:${p.line}  ${p.message}`)

const summaryLine = (problems: readonly KnowledgeProblem[]): string => `knowledge: ${problems.length} problems`
const requireBackend = (opening: KnowledgeOpening) => {
  if ('unavailable' in opening) throw new Error(opening.unavailable)
  return opening.backend
}
const requirePort = (access: KnowledgeAccess) => {
  if ('unavailable' in access) throw new Error(access.unavailable)
  return access.port
}

export interface CheckOutcome { lines: string[]; failed: boolean }

export async function runCheck(opening: KnowledgeOpening, dir: string): Promise<CheckOutcome> {
  const problems = await requireBackend(opening).check(dir)
  return { lines: [...renderProblems(problems), summaryLine(problems)], failed: problems.length > 0 }
}

export async function runFormat(opening: KnowledgeOpening, dir: string): Promise<string[]> {
  const result = await requireBackend(opening).format(dir)
  return [...result.formatted.map(l => `formatted ${l}`), ...renderProblems(result.problems), summaryLine(result.problems)]
}

export async function runCard(opening: KnowledgeOpening, dir: string, entity: string, page: { cursor: string | null; limit: number }): Promise<string[]> {
  const card = await requireBackend(opening).card(dir, entity, page)
  return [...renderClaims(card.claims), ...(card.next === null ? [] : [`more: --cursor ${card.next}`])]
}

export async function runSearch(opening: KnowledgeOpening, dir: string, query: string, limit: number): Promise<string[]> {
  return renderClaims(await requireBackend(opening).search(dir, query, limit))
}

export interface AddOptions { class: ClaimClass; text: string; anchor?: string[]; tag?: string[]; source?: string[]; decision?: string; why?: string }

export function addPatch(o: AddOptions): KnowledgePatch {
  return KnowledgePatch.parse({
    add: [{ text: o.text, class: o.class, anchors: (o.anchor ?? []).map(parseAnchorArg), tags: o.tag ?? [], sources: o.source ?? [], decision: o.decision ?? null }],
    why: o.why ?? null,
  })
}

export async function runAdd(access: KnowledgeAccess, author: MemoryAuthor, o: AddOptions): Promise<string[]> {
  const result = await requirePort(access).write({ author, idempotencyKey: null }, addPatch(o))
  return [...result.added.map(r => `added ${r.id} → ${r.location}`), ...result.warnings]
}

export async function runRetire(access: KnowledgeAccess, author: MemoryAuthor, ids: string[], why: string): Promise<string[]> {
  const result = await requirePort(access).write({ author, idempotencyKey: null }, KnowledgePatch.parse({ retire: ids, why }))
  return [...result.retired.map(r => `retired ${r.id} from ${r.location}`), ...result.warnings]
}

const anchorLabel = (a: { path: string; symbol: string | null }): string => (a.symbol === null ? a.path : `${a.path}${ANCHOR_ARG_SEPARATOR}${a.symbol}`)

export interface DriftRow { state: ClaimState; id: string; location: string; anchors: { path: string; symbol: string | null; state: ClaimState }[] }

export const driftRows = (drifts: readonly ClaimDrift[]): DriftRow[] =>
  drifts.filter(d => d.state !== ClaimState.clean).map(d => ({
    state: d.state, id: d.claim.id, location: d.claim.location,
    anchors: d.anchors.filter(a => a.state !== ClaimState.clean).map(a => ({ path: a.path, symbol: a.symbol, state: a.state })),
  }))

export const driftCounts = (drifts: readonly ClaimDrift[]): Record<ClaimState, number> => {
  const counts: Record<ClaimState, number> = { [ClaimState.clean]: 0, [ClaimState.suspect]: 0, [ClaimState.unknown]: 0, [ClaimState.unanchored]: 0 }
  for (const d of drifts) counts[d.state]++
  return counts
}

export async function runDrift(access: KnowledgeAccess, author: MemoryAuthor, paths: string[], json: boolean): Promise<string[]> {
  const drifts = await requirePort(access).drift({ author, idempotencyKey: null }, paths.length === 0 ? {} : { paths })
  const rows = driftRows(drifts)
  const counts = driftCounts(drifts)
  if (json) return [JSON.stringify({ claims: rows, counts })]
  return [
    ...rows.map(r => [r.state, r.id, r.location, ...r.anchors.map(anchorLabel)].join('  ')),
    Object.values(ClaimState).map(state => `${state} ${counts[state]}`).join(' · '),
  ]
}

export const knowledgeAuthor = (fold: WorkspaceFold, dir: string): Promise<MemoryAuthor> =>
  cwdAuthor(fold, dir, AUTHOR_SOURCE.cli, NO_CHAT(Door.cli))

export function knowledgeCommand(deps: { requireKernel: () => Kernel; project?: { config: ProjectConfig; log: EventLog } }): Command {
  const knowledge = new Command('knowledge').description('project knowledge as files in the repo: read, add, retire, format, check')
  const needProject = () => {
    if (!deps.project) throw new Error(NO_PROJECT_CONTEXT)
    return deps.project
  }
  const print = (lines: readonly string[]): void => { for (const line of lines) console.log(line) }
  const backend = () => openKnowledge(needProject().config)

  const author = () => { const { config } = needProject(); return knowledgeAuthor(deps.requireKernel(), config.dir) }
  const port = () => { const { config, log } = needProject(); return knowledgeAccess(openKnowledge(config), log, config.dir) }

  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.card} <path>`).description('the claims anchored at or under a path')
    .option('--limit <n>', 'claims per page', parsePositiveInteger).option('--cursor <c>', 'continue a previous card')
    .action(async (entity: string, o: { limit?: number; cursor?: string }) => {
      print(await runCard(backend(), needProject().config.dir, entity, { cursor: o.cursor ?? null, limit: o.limit ?? KNOWLEDGE_DEFAULTS.pageItems }))
    })
  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.search} <query>`).description('claims ranked for a query')
    .option('--limit <n>', 'at most this many', parsePositiveInteger)
    .action(async (query: string, o: { limit?: number }) => {
      print(await runSearch(backend(), needProject().config.dir, query, o.limit ?? KNOWLEDGE_DEFAULTS.searchItems))
    })
  knowledge.command(KNOWLEDGE_SUBCOMMAND.add).description('record one claim')
    .requiredOption('--class <c>', Object.values(ClaimClass).join(' | '), parseClass)
    .requiredOption('--text <text>', 'the claim, one line')
    .option('--anchor <path#symbol...>', 'code the claim is about; the first decides where it is filed')
    .option('--tag <tag...>', 'topic tags')
    .option('--source <url...>', 'where this was learned (credential-free http(s) URLs)')
    .option('--decision <slug>', 'the decision this claim comes from')
    .option('--why <text>', 'why this write happened')
    .action(async (o: AddOptions) => { print(await runAdd(port(), await author(), o)) })
  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.retire} <ids...>`).description('retire claims by id')
    .requiredOption('--why <text>', 'why they no longer hold')
    .action(async (ids: string[], o: { why: string }) => { print(await runRetire(port(), await author(), ids, o.why)) })
  knowledge.command(KNOWLEDGE_SUBCOMMAND.fmt).description('assign missing ids, restore canonical order, move misfiled claims')
    .action(async () => { print(await runFormat(backend(), needProject().config.dir)) })
  knowledge.command(KNOWLEDGE_SUBCOMMAND.check).description('validate every knowledge file; exits 1 on any problem')
    .action(async () => {
      const outcome = await runCheck(backend(), needProject().config.dir)
      print(outcome.lines)
      if (outcome.failed) throw new CommandFailure(1)
    })
  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.drift} [paths...]`).description('claims whose anchored code changed since they were last checked; reports, never fails')
    .option('--json', 'machine-readable output')
    .action(async (paths: string[], o: { json?: boolean }) => { print(await runDrift(port(), await author(), paths, o.json === true)) })
  return knowledge
}
