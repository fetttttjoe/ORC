// Knowledge-graph usefulness benchmark: replays a probe set against the live memory store and
// prints a scoreboard. Run: bun bench/graph-bench.ts [probes.json]
// ponytail: read-only console scoreboard; add JSON output when something consumes it.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
// ponytail: relative imports — bench/ is not a workspace package and doesn't need to be
import { LinkKind, NoteTier, SEARCH_MODE, SearchMode, type ClaimHit, type NoteSummary } from '../packages/contracts/src/index.ts'
import { loadConfig, openStorage, requireProject } from '../packages/kernel/src/index.ts'
import { openMemory } from '../packages/cli/src/memory-open.ts'
import { z } from 'zod'

// WHICH probe set, read at runtime rather than statically imported, because a probe file names NOTE
// IDS and is therefore a property of ONE corpus. The project itself already comes from the cwd
// (loadConfig walks up for .orc), so this file could always be pointed at a second project — and
// doing so graded every positive as a miss, silently, since the committed set names orc-sim's ids
// and no other corpus has them. An argument keeps probes.json the default for `bun bench/graph-bench.ts`.
const probesFile = process.argv[2] ?? path.join(import.meta.dir, 'probes.json')
const rawProbes: unknown = JSON.parse(readFileSync(probesFile, 'utf8'))

// The five question shapes a retrieval benchmark has to separate, because they fail differently:
// a synonym miss is an embedder problem, a cross-page miss is a ranking problem, and a NEGATIVE
// miss is neither — it is the system answering a question the corpus cannot answer, which no
// positive-only benchmark can see. Borrowed from claude-obsidian's v1.7 retrieval corpus.
const PROBE_CATEGORY = ['derived', 'synonym', 'cross-page', 'partial-recall', 'negative'] as const

// The filter fields a probe may exercise, mirroring MemoryFilter minus `scope` (every probe runs in
// the default project scope already). store.search()/searchClaims() apply this via matchesRow
// (surreal.ts) — plain TS .includes()/=== checks run by BOTH raw arms. store.list()'s builder-based
// filter is a DIFFERENT path and, measured here, a broken one: `orc memory ls --category subsystem`
// throws `n.categories.contains is not a function` against surqlize/SurrealDB 3.2.0. A filtered probe
// exercises the path search() actually uses, not the CLI ls one.
const ProbeFilter = z.object({ category: z.string().optional(), tag: z.string().optional(), tier: z.enum(NoteTier).optional() })

const SearchProbe = z.object({
  q: z.string(),
  // An EMPTY `expect` is the negative case. `tolerate` names ids a near-miss may return without
  // failing: "do not answer confidently" is the assertion, not "return literally nothing" — a
  // cosine ranker with no floor can never return nothing, which is exactly the finding.
  expect: z.array(z.string()),
  tolerate: z.array(z.string()).default([]),
  category: z.enum(PROBE_CATEGORY).default('derived'),
  filter: ProbeFilter.optional(),
  why: z.string().optional(),
})
// Claim-level probes: same shape as SearchProbe, graded against searchClaims() instead of search().
// `expect`/`tolerate` name the claim's OWNING NOTE (ClaimHit.noteId), because that is what a caller
// reads next and what every other probe in this file already names — not the claim's content-hash
// id, which would make a probe file entry meaningless to a human reader.
const ClaimProbe = SearchProbe.omit({ filter: true })
const NeighborProbe = z.object({
  seed: z.string(),
  kinds: z.array(z.string()).optional(),
  expectMin: z.array(z.string()),
  minScoreSpread: z.number().optional(),
  why: z.string().optional(),
})
const probes = z.object({
  comment: z.string(),
  search: z.array(SearchProbe),
  claims: z.array(ClaimProbe),
  neighbors: z.array(NeighborProbe),
}).parse(rawProbes)

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
// openMemory, NOT createMemory: memory-open.ts is the one path the CLI and the runtime share, and
// it is what injects the configured embedder. Constructing the store directly scored the keyword
// arm alone — three probes reported as retrieval failures were hybrid hits the benchmark could not
// see, and a negative probe would have passed trivially because substring-AND matches nothing.
const memory = await openMemory({ log: storage.events, config })
await memory.projector.catchUp()
const head = execSync('git rev-parse HEAD', { cwd: config.dir }).toString().trim()

// The three surfaces graded below, in the order store.search()/searchClaims() define them.
// 'keyword' and 'semantic' are the raw retrieval channels; 'hybrid' is what a caller actually gets —
// keyword+semantic fused by rrfFuse (rank.ts). They are graded SEPARATELY, alongside the fused
// result, because two changes on this branch moved an arm's own ranking measurably and left the
// fused total completely unchanged: b74142f (semantic re-rank: cos×heat over (cos+1)×heat) took the
// semantic arm from 7/15 to 9/15 top-1; 2a1075f (keyword OR+quorum over substring-AND) took the note
// arm's zero-result rate from 13/20 to 4/20 and the claim arm's from 16/20 to 8/20. Both measured
// with throwaway scratchpad scripts because nothing in this file could see either one — rrfFuse
// consumes rank ORDER and discards score magnitude, so a within-arm reordering can't move the fused
// number unless it flips cross-arm rank order. Reuses SearchMode (contracts) rather than a second
// spelling of the same three names.
const ARM_LABEL: Record<SearchMode, string> = { keyword: 'keyword', semantic: 'semantic', hybrid: 'fused' }
// The two raw channels, derived from SearchMode rather than a second hand-spelled list — a mode
// added to contracts (or renamed) shows up, or drops out, here without this file going stale.
const RAW_ARMS: readonly SearchMode[] = Object.values(SearchMode).filter(m => m !== SEARCH_MODE.hybrid)
// One spelling of the two probe kinds this file grades, used by recordDivergence's labels below —
// a bare 'search'/'claim' string at each call site is exactly the drift this repo's string-literal
// rule exists to catch.
const PROBE_KIND = { search: 'search', claim: 'claim' } as const

interface ArmGrade { ok: boolean; top1: boolean; hitAt: number | undefined; zeroResult: boolean }
// One grading rule, shared by every arm and both probe types (note search, claim search): a
// negative passes when nothing outside `tolerate` came back; a positive passes when `expect`
// appears anywhere in the top 3, and ADDITIONALLY at top-1, because "somewhere in three" and
// "ranked first" are different qualities and only the second survives a small agent budget.
const gradeIds = (ids: readonly string[], fullCount: number, expect: readonly string[], tolerate: readonly string[]): ArmGrade => {
  const negative = expect.length === 0
  const hitAt = negative ? -1 : ids.findIndex(id => expect.includes(id))
  return {
    ok: negative ? ids.every(id => tolerate.includes(id)) : hitAt !== -1,
    top1: hitAt === 0,
    hitAt: hitAt === -1 ? undefined : hitAt,
    zeroResult: fullCount === 0,
  }
}
// Runs one probe query through all three SearchMode values and grades each — the seam this whole
// file exists to use is `{ mode }` on store.search()/searchClaims(), never their private arm methods.
// Generic over T (NoteSummary | ClaimHit) so note probes and claim probes share one code path
// instead of two near-identical copies that could drift on what "a hit" means. Three explicit calls
// rather than a loop into a built-up object: SearchMode has exactly three literal members, and this
// way the Record is fully inferred — no `as` cast standing in for what TS can just be shown.
async function runModes<T>(
  fetch: (mode: SearchMode) => Promise<T[]>,
  idOf: (row: T) => string,
  expect: readonly string[],
  tolerate: readonly string[],
): Promise<Record<SearchMode, ArmGrade & { top: T[] }>> {
  const grade = async (mode: SearchMode): Promise<ArmGrade & { top: T[] }> => {
    const full = await fetch(mode)
    const top = full.slice(0, 3)
    return { ...gradeIds(top.map(idOf), full.length, expect, tolerate), top }
  }
  const keyword = await grade(SEARCH_MODE.keyword)
  const semantic = await grade(SEARCH_MODE.semantic)
  const hybrid = await grade(SEARCH_MODE.hybrid)
  return { keyword, semantic, hybrid }
}
const armCode = (g: ArmGrade, negative: boolean): string => {
  if (negative) return g.ok ? 'ok' : 'NO'
  if (g.zeroResult) return '0res'
  return g.hitAt !== undefined ? `@${g.hitAt + 1}` : 'x'
}

interface ArmTally { pass3: number; top1: number; zero: number; total: number }
const zeroTally = (): ArmTally => ({ pass3: 0, top1: 0, zero: 0, total: 0 })
const newArmTally = (): Record<SearchMode, ArmTally> => ({ keyword: zeroTally(), semantic: zeroTally(), hybrid: zeroTally() })
const recordArm = (tallies: Record<SearchMode, ArmTally>, grades: Record<SearchMode, ArmGrade>): void => {
  for (const mode of Object.values(SearchMode)) {
    const t = tallies[mode]
    t.total += 1
    if (grades[mode].ok) t.pass3 += 1
    if (grades[mode].top1) t.top1 += 1
    if (grades[mode].zeroResult) t.zero += 1
  }
}
const searchArms = newArmTally()
const claimArms = newArmTally()
// Where an arm carries a probe the fused surface loses, or vice versa — the signal rrfFuse hides
// from every number above it: a probe where keyword's or semantic's OWN top-3 verdict disagrees
// with the fused verdict. This is what would have shown b74142f and 2a1075f moving something, even
// though the fused 19/23 total did not.
const divergences: string[] = []
const recordDivergence = (label: string, q: string, grades: Record<SearchMode, ArmGrade>): void => {
  const fused = grades.hybrid
  for (const mode of RAW_ARMS) {
    const g = grades[mode]
    if (g.ok !== fused.ok)
      divergences.push(`${label.padEnd(6)} ${ARM_LABEL[mode].padEnd(8)}=${g.ok ? 'PASS' : 'FAIL'}  fused=${fused.ok ? 'PASS' : 'FAIL'}  "${q}"`)
  }
}

let pass = 0
let total = 0
const stale = new Set<string>()
const line = (ok: boolean, label: string, detail: string): void => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
}
const byCategory = new Map<string, { pass: number; total: number; top1: number }>()
const tally = (cat: string, ok: boolean, first: boolean): void => {
  const c = byCategory.get(cat) ?? { pass: 0, total: 0, top1: 0 }
  byCategory.set(cat, { pass: c.pass + (ok ? 1 : 0), total: c.total + 1, top1: c.top1 + (first ? 1 : 0) })
}

// Name the corpus AND the probe set: two runs of this file now differ in both, and a scoreboard
// that names neither is unreadable a day later.
console.log(`graph-bench @ ${head.slice(0, 7)}  project=${config.projectName}  probes=${path.basename(probesFile)}\n`)

for (const p of probes.search) {
  const negative = p.expect.length === 0
  const grades = await runModes(mode => memory.store.search(p.q, p.filter ?? {}, { mode }), (n: NoteSummary) => n.id, p.expect, p.tolerate)
  const f = grades.hybrid
  tally(p.category, f.ok, f.top1)
  recordArm(searchArms, grades)
  recordDivergence(PROBE_KIND.search, p.q, grades)
  const label = `${p.category} "${p.q}"${p.filter ? ` filter=${JSON.stringify(p.filter)}` : ''}`
  const detail = negative
    ? (f.ok ? 'silent' : `answered anyway: [${f.top.map(n => n.id).join(', ')}]`)
    : (f.hitAt !== undefined ? `hit ${f.top[f.hitAt].id} @${f.hitAt + 1}` : `top3=[${f.top.map(n => n.id).join(', ')}]`)
  line(f.ok, label, `${detail}  (kw=${armCode(grades.keyword, negative)} sem=${armCode(grades.semantic, negative)})`)
  if (f.hitAt !== undefined) {
    const hitNote = f.top[f.hitAt]
    // path-aware staleness: HEAD moving is not drift — a commit touching the note's declared
    // paths since its stamp is. Notes without paths fall back to the strict HEAD comparison.
    // The summary carries sourceRevision and paths for exactly this (contracts NoteSummary) —
    // refetching the full note read `paths` off the MemoryNote union, where only the semantic
    // tier has it, and crashed on any episodic/plan hit.
    if (hitNote.sourceRevision && hitNote.sourceRevision !== head) {
      const touched = hitNote.paths.length
        ? execSync(`git rev-list ${hitNote.sourceRevision}..HEAD -- ${hitNote.paths.map(p => `'${p}'`).join(' ')}`, { cwd: config.dir }).toString().trim()
        : 'no-paths'
      if (touched) stale.add(hitNote.id)
    }
  }
}

console.log('')
for (const p of probes.claims) {
  const negative = p.expect.length === 0
  const grades = await runModes(mode => memory.store.searchClaims(p.q, {}, { mode }), (c: ClaimHit) => c.noteId, p.expect, p.tolerate)
  const f = grades.hybrid
  recordArm(claimArms, grades)
  recordDivergence(PROBE_KIND.claim, p.q, grades)
  const detail = negative
    ? (f.ok ? 'silent' : `answered anyway: [${f.top.map(c => c.noteId).join(', ')}]`)
    : (f.hitAt !== undefined ? `hit ${f.top[f.hitAt].noteId} @${f.hitAt + 1}` : `top3=[${f.top.map(c => c.noteId).join(', ')}]`)
  line(f.ok, `claim ${p.category} "${p.q}"`, `${detail}  (kw=${armCode(grades.keyword, negative)} sem=${armCode(grades.semantic, negative)})`)
}

console.log('')
for (const p of probes.neighbors) {
  const ns = await memory.store.neighbors(p.seed, { kinds: p.kinds?.map(k => z.enum(LinkKind).parse(k)) })
  const ids = new Set(ns.map(n => n.id))
  const missing = p.expectMin.filter(id => !ids.has(id))
  const scores = ns.map(n => n.score)
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0
  const spreadOk = p.minScoreSpread === undefined || spread >= p.minScoreSpread
  line(missing.length === 0 && spreadOk, `neighbors ${p.seed}${p.kinds ? `[${p.kinds}]` : ''}`,
    missing.length ? `missing=[${missing.join(', ')}]` : spreadOk ? `${ns.length} notes, spread=${spread.toFixed(2)}` : `flat scores (spread=${spread.toFixed(2)})`)
}

console.log('')
for (const [cat, c] of byCategory)
  console.log(`${cat.padEnd(14)} ${c.pass}/${c.total} top-3` + (cat === 'negative' ? '' : `  ${c.top1}/${c.total} top-1`))

// How each arm scores ALONE, next to the fused row every number above already showed. top-1 is
// counted only over probes with a non-empty `expect` (a negative has no "ranked first" to hit), so
// the denominator matches byCategory's own top-1 columns above. zero-result is every probe's
// denominator, because an arm going silent on a POSITIVE probe is the regression 2a1075f fixed and
// an arm going silent on a NEGATIVE one is the correct behaviour — this file draws no line between
// them, the per-probe `NO`/`ok` marks above already do.
const posTotal = (ps: readonly { expect: readonly string[] }[]): number => ps.filter(p => p.expect.length > 0).length
const armTable = (title: string, tallies: Record<SearchMode, ArmTally>, positives: number): void => {
  console.log(`\n${title}`)
  for (const mode of Object.values(SearchMode)) {
    const t = tallies[mode]
    console.log(`  ${ARM_LABEL[mode].padEnd(8)} ${String(t.pass3).padStart(2)}/${t.total} top-3   ${String(t.top1).padStart(2)}/${positives} top-1   zero-result ${t.zero}/${t.total}`)
  }
}
if (probes.search.length) armTable('search arms (notes):', searchArms, posTotal(probes.search))
if (probes.claims.length) armTable('search arms (claims):', claimArms, posTotal(probes.claims))

console.log(divergences.length ? '\nDIVERGENCE — arm and fused disagree (what rrfFuse hides from every count above):' : '\nDIVERGENCE — none: every arm agrees with the fused surface on every probe')
for (const d of divergences) console.log(`  ${d}`)

console.log(`\nscore: ${pass}/${total}${stale.size ? `  STALE vs HEAD: [${[...stale].join(', ')}]` : '  all hits current'}`)
process.exit(pass === total && stale.size === 0 ? 0 : 1)
