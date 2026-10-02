// How many claims read suspect per commit window, file level versus claim state. Run: bun bench/knowledge-drift.ts [--window 10] [--span 80]
import { z } from 'zod'
import { anchorState, claimState, ClaimState, NO_ANCHOR_EVIDENCE, ROOT_ENTITY, type KnowledgeAnchor, type KnowledgeClaim } from '../packages/contracts/src/index.ts'
import { readingOf } from '../packages/knowledge-core/src/index.ts'
import { createDrift, createOutlineCache, gitFilesPlugin, runGit } from '../plugins/knowledge-git/src/index.ts'
import { createTreeSitterStructure } from '../plugins/structure-treesitter/src/index.ts'

const FLAG = { window: '--window', span: '--span' } as const
const DEFAULTS = { window: 10, span: 80 } as const
const PAGE_LIMIT = 200
const SHORT = 8

const Count = z.coerce.number().int().positive()

const flagValue = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name)
  return at < 0 ? fallback : Count.parse(process.argv[at + 1])
}

const commitsPerWindow = flagValue(FLAG.window, DEFAULTS.window)
const span = flagValue(FLAG.span, DEFAULTS.span)
const checkout = process.cwd()

const lines = async (args: readonly string[], stdin?: string): Promise<string[]> =>
  new TextDecoder().decode(await runGit(checkout, args, stdin)).split('\n').filter(line => line !== '')

const structure = createTreeSitterStructure()
const backend = gitFilesPlugin.create({}, { structure })
const drift = createDrift({ outlineOf: createOutlineCache(structure) })

const readClaims = async (): Promise<KnowledgeClaim[]> => {
  const claims: KnowledgeClaim[] = []
  let cursor: string | null = null
  do {
    const card = await backend.card(checkout, ROOT_ENTITY, { cursor, limit: PAGE_LIMIT })
    claims.push(...card.claims)
    cursor = card.next
  } while (cursor !== null)
  return claims
}

const existsAt = async (revision: string, paths: readonly string[]): Promise<boolean> => {
  const out = await lines(['cat-file', '--batch-check'], paths.map(p => `${revision}:${p}\n`).join(''))
  return out.every(line => !line.endsWith(' missing'))
}

const touches = (anchor: KnowledgeAnchor, changed: readonly string[]): boolean =>
  changed.some(file => file === anchor.path || file.startsWith(`${anchor.path.replace(/\/$/, '')}/`))

const stateOf = async (claim: KnowledgeClaim, from: string, to: string): Promise<ClaimState> => {
  const states = await Promise.all(claim.anchors.map(async anchor => {
    const [basis, current] = await Promise.all([drift.anchorDigestAt(checkout, from, anchor), drift.anchorDigestAt(checkout, to, anchor)])
    return anchorState(readingOf(anchor, basis, current), NO_ANCHOR_EVIDENCE)
  }))
  return claimState(states)
}

const pct = (n: number, of: number): string => (of === 0 ? '0.0' : ((100 * n) / of).toFixed(1)).padStart(5)

const claims = (await readClaims()).filter(claim => claim.anchors.length > 0)
const commits = (await lines(['rev-list', '--first-parent', '-n', String(span + 1), 'HEAD'])).reverse()
const windows = Math.floor((commits.length - 1) / commitsPerWindow)

let considered = 0
let fileLevel = 0
let suspect = 0
let unknown = 0
console.log(`${claims.length} anchored claims, ${windows} windows of ${commitsPerWindow} commits`)
console.log('range              files  considered  file-level      claim-state   unknown')
for (let w = 0; w < windows; w++) {
  const from = commits[w * commitsPerWindow]
  const to = commits[(w + 1) * commitsPerWindow]
  const changed = await lines(['diff', '--name-only', from, to])
  const present: KnowledgeClaim[] = []
  for (const claim of claims) if (await existsAt(from, claim.anchors.map(a => a.path))) present.push(claim)
  const file = present.filter(claim => claim.anchors.some(anchor => touches(anchor, changed))).length
  const states = await Promise.all(present.map(claim => stateOf(claim, from, to)))
  const sus = states.filter(s => s === ClaimState.suspect).length
  const unk = states.filter(s => s === ClaimState.unknown).length
  considered += present.length
  fileLevel += file
  suspect += sus
  unknown += unk
  console.log(`${from.slice(0, SHORT)}..${to.slice(0, SHORT)}  ${String(changed.length).padStart(5)}  ${String(present.length).padStart(10)}  ${String(file).padStart(4)} ${pct(file, present.length)}%  ${String(sus).padStart(4)} ${pct(sus, present.length)}%  ${String(unk).padStart(7)}`)
}
const reduction = fileLevel === 0 ? 0 : (100 * (fileLevel - suspect)) / fileLevel
console.log(`total: ${considered} claim-windows, file-level ${fileLevel} (${pct(fileLevel, considered).trim()}%), claim-state ${suspect} (${pct(suspect, considered).trim()}%), unknown ${unknown}, reduction ${reduction.toFixed(1)}%`)
