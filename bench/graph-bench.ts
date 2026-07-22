// Knowledge-graph usefulness benchmark: replays bench/probes.json against the live
// memory store and prints a scoreboard. Run: bun bench/graph-bench.ts
// ponytail: read-only console scoreboard; add JSON output when something consumes it.
import { execSync } from 'node:child_process'
// ponytail: relative imports — bench/ is not a workspace package and doesn't need to be
import { LinkKind, MemoryScope } from '../packages/contracts/src/index.ts'
import { loadConfig, openStorage, requireProject } from '../packages/kernel/src/index.ts'
import { createMemory } from '../plugins/memory/src/index.ts'
import probes from './probes.json'

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const memory = await createMemory({ log: storage.events, config })
await memory.projector.catchUp()
const head = execSync('git rev-parse HEAD', { cwd: config.dir }).toString().trim()

let pass = 0
let total = 0
const stale = new Set<string>()
const line = (ok: boolean, label: string, detail: string): void => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
}

console.log(`graph-bench @ ${head.slice(0, 7)}\n`)

for (const p of probes.search) {
  const top = (await memory.store.search(p.q)).slice(0, 3)
  const hit = top.find(n => p.expect.includes(n.id))
  line(!!hit, `search "${p.q}"`, hit ? `hit ${hit.id} @${top.indexOf(hit) + 1}` : `top3=[${top.map(n => n.id).join(', ')}]`)
  if (hit) {
    const note = await memory.store.get(hit.id, MemoryScope.project)
    // path-aware staleness: HEAD moving is not drift — a commit touching the note's declared
    // paths since its stamp is. Notes without paths fall back to the strict HEAD comparison.
    if (note && note.sourceRevision && note.sourceRevision !== head) {
      const touched = note.paths.length
        ? execSync(`git rev-list ${note.sourceRevision}..HEAD -- ${note.paths.map(p => `'${p}'`).join(' ')}`, { cwd: config.dir }).toString().trim()
        : 'no-paths'
      if (touched) stale.add(hit.id)
    }
  }
}

console.log('')
for (const p of probes.neighbors) {
  const ns = await memory.store.neighbors(p.seed, { kinds: p.kinds?.map(k => LinkKind.parse(k)) })
  const ids = new Set(ns.map(n => n.id))
  const missing = p.expectMin.filter(id => !ids.has(id))
  const scores = ns.map(n => n.score)
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0
  const spreadOk = p.minScoreSpread === undefined || spread >= p.minScoreSpread
  line(missing.length === 0 && spreadOk, `neighbors ${p.seed}${p.kinds ? `[${p.kinds}]` : ''}`,
    missing.length ? `missing=[${missing.join(', ')}]` : spreadOk ? `${ns.length} notes, spread=${spread.toFixed(2)}` : `flat scores (spread=${spread.toFixed(2)})`)
}

console.log(`\nscore: ${pass}/${total}${stale.size ? `  STALE vs HEAD: [${[...stale].join(', ')}]` : '  all hits current'}`)
process.exit(pass === total && stale.size === 0 ? 0 : 1)
