// Audit every file access a task's agents made against forbidden path patterns
// (e.g. the sealed baseline). Run: bun bench/contamination-check.ts <taskId-prefix> [pattern...]
// Exit 1 if any forbidden path was read — the run's judgement data is then tainted.
// ponytail: relative imports — bench/ is not a workspace package and doesn't need to be
import { loadConfig, openStorage, requireProject } from '../packages/kernel/src/index.ts'

const [prefix, ...patterns] = process.argv.slice(2)
if (!prefix) { console.error('usage: bun bench/contamination-check.ts <taskId-prefix> [pattern...]'); process.exit(2) }
const forbidden = patterns.length ? patterns : ['bench/scenarios', 'SEALED']

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const evs = await storage.events.after(0, ['tool_call'])

let reads = 0
const hits: string[] = []
for (const e of evs) {
  if (!e.taskId?.startsWith(prefix)) continue
  const p = e.payload as { toolName?: string; input?: { path?: string } }
  if (p.toolName !== 'fs_read' && p.toolName !== 'fs_list') continue
  reads += 1
  const path = p.input?.path ?? ''
  if (forbidden.some(f => path.includes(f))) hits.push(`${p.toolName} ${path} (step ${e.stepId})`)
}

console.log(`${reads} file reads/lists by task ${prefix}`)
if (hits.length) {
  console.error(`CONTAMINATED — forbidden paths accessed:`)
  for (const h of hits) console.error(`  ${h}`)
  process.exit(1)
}
console.log(`clean: no access to [${forbidden.join(', ')}]`)
process.exit(0)
