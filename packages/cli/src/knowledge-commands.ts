import { Command } from 'commander'
import {
  AUTHOR_SOURCE, ClaimClass, Door, KnowledgePatch, NO_CHAT,
  type KnowledgeBackend, type KnowledgeClaim, type KnowledgePort, type KnowledgeProblem, type MemoryAuthor,
} from '@orc/contracts'
import type { EventLog, Kernel, ProjectConfig } from '@orc/kernel'
import { cwdAuthor, type WorkspaceFold } from './cwd-workspace'
import { enumArg } from './enum-arg'
import { parsePositiveInteger } from './int-arg'
import { CommandFailure } from './exit'
import { knowledgeBackendFor, openKnowledgePort } from './knowledge-open'

export const KNOWLEDGE_SUBCOMMAND = { card: 'card', search: 'search', add: 'add', retire: 'retire', fmt: 'fmt', check: 'check' } as const
export const KNOWLEDGE_OFF = 'knowledge is off for this project (.orc/config.json "knowledge": null)'
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
const requireBackend = (backend: KnowledgeBackend | null): KnowledgeBackend => {
  if (backend === null) throw new Error(KNOWLEDGE_OFF)
  return backend
}
const requirePort = (port: KnowledgePort | null): KnowledgePort => {
  if (port === null) throw new Error(KNOWLEDGE_OFF)
  return port
}

export interface CheckOutcome { lines: string[]; failed: boolean }

export async function runCheck(backend: KnowledgeBackend | null, dir: string): Promise<CheckOutcome> {
  const problems = await requireBackend(backend).check(dir)
  return { lines: [...renderProblems(problems), summaryLine(problems)], failed: problems.length > 0 }
}

export async function runFormat(backend: KnowledgeBackend | null, dir: string): Promise<string[]> {
  const result = await requireBackend(backend).format(dir)
  return [...result.formatted.map(l => `formatted ${l}`), ...renderProblems(result.problems), summaryLine(result.problems)]
}

export async function runCard(backend: KnowledgeBackend | null, dir: string, entity: string, page: { cursor: string | null; limit: number }): Promise<string[]> {
  const card = await requireBackend(backend).card(dir, entity, page)
  return [...renderClaims(card.claims), ...(card.next === null ? [] : [`more: --cursor ${card.next}`])]
}

export async function runSearch(backend: KnowledgeBackend | null, dir: string, query: string, limit: number): Promise<string[]> {
  return renderClaims(await requireBackend(backend).search(dir, query, limit))
}

export interface AddOptions { class: ClaimClass; text: string; anchor?: string[]; tag?: string[]; source?: string[]; decision?: string; why?: string }

export function addPatch(o: AddOptions): KnowledgePatch {
  return KnowledgePatch.parse({
    add: [{ text: o.text, class: o.class, anchors: (o.anchor ?? []).map(parseAnchorArg), tags: o.tag ?? [], sources: o.source ?? [], decision: o.decision ?? null }],
    why: o.why ?? null,
  })
}

export async function runAdd(port: KnowledgePort | null, author: MemoryAuthor, o: AddOptions): Promise<string[]> {
  const result = await requirePort(port).write({ author, idempotencyKey: null }, addPatch(o))
  return [...result.added.map(r => `added ${r.id} → ${r.location}`), ...result.warnings]
}

export async function runRetire(port: KnowledgePort | null, author: MemoryAuthor, ids: string[], why: string): Promise<string[]> {
  const result = await requirePort(port).write({ author, idempotencyKey: null }, KnowledgePatch.parse({ retire: ids, why }))
  return [...result.retired.map(r => `retired ${r.id} from ${r.location}`), ...result.warnings]
}

export const knowledgeAuthor = (fold: WorkspaceFold, dir: string): Promise<MemoryAuthor> =>
  cwdAuthor(fold, dir, AUTHOR_SOURCE.cli, NO_CHAT(Door.cli))

export function knowledgeCommand(deps: { requireKernel: () => Kernel; project?: { config: ProjectConfig; log: EventLog } }): Command {
  const knowledge = new Command('knowledge').description('project knowledge as files in the repo: read, add, retire, format, check')
  const needProject = () => {
    if (!deps.project) throw new Error('knowledge commands need a project context')
    return deps.project
  }
  const print = (lines: readonly string[]): void => { for (const line of lines) console.log(line) }
  const backend = () => knowledgeBackendFor(needProject().config)

  const author = () => { const { config } = needProject(); return knowledgeAuthor(deps.requireKernel(), config.dir) }
  const port = () => { const { config, log } = needProject(); return openKnowledgePort({ config, log }) }

  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.card} <path>`).description('the claims anchored at or under a path')
    .option('--limit <n>', 'claims per page', parsePositiveInteger).option('--cursor <c>', 'continue a previous card')
    .action(async (entity: string, o: { limit?: number; cursor?: string }) => {
      print(await runCard(backend(), needProject().config.dir, entity, { cursor: o.cursor ?? null, limit: o.limit ?? 50 }))
    })
  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.search} <query>`).description('claims ranked for a query')
    .option('--limit <n>', 'at most this many', parsePositiveInteger)
    .action(async (query: string, o: { limit?: number }) => {
      print(await runSearch(backend(), needProject().config.dir, query, o.limit ?? 20))
    })
  knowledge.command(KNOWLEDGE_SUBCOMMAND.add).description('record one claim')
    .requiredOption('--class <c>', Object.values(ClaimClass).join(' | '), parseClass)
    .requiredOption('--text <text>', 'the claim, one line')
    .option('--anchor <path#symbol...>', 'code the claim is about; the first decides where it is filed')
    .option('--tag <tag...>', 'topic tags')
    .option('--source <url...>', 'where this was learned (credential-free http(s) URLs)')
    .option('--decision <slug>', 'the decision this claim comes from')
    .option('--why <text>', 'why this write happened')
    .action(async (o: AddOptions) => { const p = requirePort(port()); print(await runAdd(p, await author(), o)) })
  knowledge.command(`${KNOWLEDGE_SUBCOMMAND.retire} <ids...>`).description('retire claims by id')
    .requiredOption('--why <text>', 'why they no longer hold')
    .action(async (ids: string[], o: { why: string }) => { const p = requirePort(port()); print(await runRetire(p, await author(), ids, o.why)) })
  knowledge.command(KNOWLEDGE_SUBCOMMAND.fmt).description('assign missing ids, restore canonical order, move misfiled claims')
    .action(async () => { print(await runFormat(backend(), needProject().config.dir)) })
  knowledge.command(KNOWLEDGE_SUBCOMMAND.check).description('validate every knowledge file; exits 1 on any problem')
    .action(async () => {
      const outcome = await runCheck(backend(), needProject().config.dir)
      print(outcome.lines)
      if (outcome.failed) throw new CommandFailure(1)
    })
  return knowledge
}
