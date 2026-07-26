// Is the knowledge graph CORRECT (edges lead somewhere, text is not corrupted) and USEFUL (notes
// are reachable and actually read)? Run inside a project:
//
//   bun scripts/graph-audit.ts
//
// Exits non-zero when a correctness class is non-empty, so a bench cell can assert graph health
// instead of assuming it. Usefulness is reported, never failed on — a cold note is a fact about a
// run, not a defect.
//
// Every edge is classified with the SAME rule traversal uses — contracts `linkLookupScopes`, own
// scope then project — so this report and the runtime can never disagree about whether an edge can
// be followed. A target that exists in NO scope is called out separately from one that resolves
// outside the lookup path, because the two have different causes and different fixes.
import { loadConfig, openStorage } from '../packages/kernel/src/index'
import { createMemory } from '../plugins/memory/src/index'
import { linkLookupScopes, noteKey } from '../packages/contracts/src/index'

const EDGE_VERDICT = { reachable: 'reachable', crossScope: 'cross-scope', dead: 'dead' } as const
type EdgeVerdict = (typeof EDGE_VERDICT)[keyof typeof EDGE_VERDICT]

const config = loadConfig()
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const memory = await createMemory({ log: storage.events, config })

const summaries = await memory.store.list()
const notes = []
for (const s of summaries) {
  const n = await memory.store.get(s.id, s.scope)
  if (n) notes.push({ note: n, hits: s.hits })
}

const byKey = new Map(notes.map(n => [noteKey(n.note.scope, n.note.id), n]))
const idsAnywhere = new Map<string, string[]>() // id → scopes holding it
for (const { note } of notes) idsAnywhere.set(note.id, [...(idsAnywhere.get(note.id) ?? []), note.scope])

// resolvable by the runtime's own rule → reachable; exists but outside the lookup path → cross-scope
const classify = (fromScope: string, targetId: string): EdgeVerdict => {
  for (const s of linkLookupScopes(fromScope)) if (byKey.has(noteKey(s, targetId))) return EDGE_VERDICT.reachable
  return idsAnywhere.has(targetId) ? EDGE_VERDICT.crossScope : EDGE_VERDICT.dead
}

const edges: Array<{ from: string; kind: string; to: string; verdict: EdgeVerdict }> = []
const inbound = new Map<string, number>()
for (const { note } of notes)
  for (const l of note.links) {
    const verdict = classify(note.scope, l.id)
    edges.push({ from: `${note.scope}/${note.id}`, kind: l.kind, to: l.id, verdict })
    if (verdict === EDGE_VERDICT.reachable) {
      const target = noteKey(note.scope, l.id)
      inbound.set(target, (inbound.get(target) ?? 0) + 1)
    }
  }

const of = (v: EdgeVerdict) => edges.filter(e => e.verdict === v)
const reachableOut = new Set(edges.filter(e => e.verdict === EDGE_VERDICT.reachable).map(e => e.from))
// A note no reachable edge touches, in or out: findable by search alone, never by traversal — which
// is the whole point of a graph, so it is counted as a correctness signal, not a taste one.
const orphans = notes.filter(n => {
  const key = noteKey(n.note.scope, n.note.id)
  return !reachableOut.has(`${n.note.scope}/${n.note.id}`) && (inbound.get(key) ?? 0) === 0
})
const textOf = (n: (typeof notes)[number]): string =>
  [n.note.title, n.note.summary, n.note.body].join('\n')
const corrupted = notes.filter(n => /\\"|\\`/.test(textOf(n)))
const emptySummary = notes.filter(n => n.note.summary.trim() === '')
const cold = notes.filter(n => n.hits === 0)

const show = (label: string, rows: string[], limit = 15): void => {
  console.log(`\n## ${label} (${rows.length})`)
  for (const r of rows.slice(0, limit)) console.log(`  ${r}`)
  if (rows.length > limit) console.log(`  … ${rows.length - limit} more`)
}

console.log(`project: ${config.projectName} (${config.projectId})`)
console.log(`notes: ${notes.length}   edges: ${edges.length}`)
console.log(`edges: reachable=${of(EDGE_VERDICT.reachable).length}  cross-scope=${of(EDGE_VERDICT.crossScope).length}  dead=${of(EDGE_VERDICT.dead).length}`)
console.log(`read: hot=${notes.length - cold.length}  cold=${cold.length}`)

show('DEAD edges — the target exists in no scope, so the claim is false', of(EDGE_VERDICT.dead).map(e => `${e.from} --${e.kind}--> ${e.to}`))
show('CROSS-SCOPE edges — the target exists elsewhere; traversal is scope-local, so these return nothing',
  of(EDGE_VERDICT.crossScope).map(e => `${e.from} --${e.kind}--> ${e.to} (lives in ${idsAnywhere.get(e.to)?.join(', ')})`))
show('ORPHANS — no reachable edge in or out; reachable by search only', orphans.map(n => `${n.note.scope}/${n.note.id} [${n.note.tier}]`))
show('CORRUPTED text — escaped quotes/backticks a writer double-encoded', corrupted.map(n => `${n.note.scope}/${n.note.id}`))
show('EMPTY summary — invisible to the retrieval surface', emptySummary.map(n => `${n.note.scope}/${n.note.id}`))

await memory.close()
await storage.close()

// correctness gates the exit code; "cold" and orphan counts are reported for judgement, not enforced
const broken = of(EDGE_VERDICT.dead).length + of(EDGE_VERDICT.crossScope).length + corrupted.length + emptySummary.length
console.log(`\n${broken === 0 ? 'graph is structurally sound' : `${broken} structural problem(s)`}`)
process.exit(broken === 0 ? 0 : 1)
