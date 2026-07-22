// Actual token/cost numbers for a task subtree, folded from the event log.
// Run: bun bench/task-usage.ts <rootTaskId>
// ponytail: relative imports — bench/ is not a workspace package and doesn't need to be
import { fold, loadConfig, openStorage, requireProject, stepUsage, subtreeTaskIds, taskUsage } from '../packages/kernel/src/index.ts'

const root = process.argv[2]
if (!root) { console.error('usage: bun bench/task-usage.ts <rootTaskId>'); process.exit(2) }

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const events = await storage.events.all()
const state = fold(events)

const ids = [...new Set([root, ...subtreeTaskIds(state, root)])]
const fmt = (n: number): string => n.toLocaleString('en-US')
let iterations = 0
let firstTs = ''
let lastTs = ''
for (const e of events) {
  if (!e.taskId?.startsWith(root)) continue
  if (!firstTs) firstTs = e.ts
  lastTs = e.ts
  if (e.kind === 'agent_call') iterations += 1
}

let inTok = 0, outTok = 0, cacheTok = 0, cost = 0
for (const id of ids) {
  const u = taskUsage(state, id)
  if (u.inputTokens === 0 && u.outputTokens === 0) continue
  inTok += u.inputTokens; outTok += u.outputTokens
  cacheTok += u.cacheReadTokens ?? 0; cost += u.costUSD ?? 0
  console.log(`task ${id.slice(0, 40)}…  in=${fmt(u.inputTokens)} out=${fmt(u.outputTokens)} cacheRead=${fmt(u.cacheReadTokens ?? 0)} $${(u.costUSD ?? 0).toFixed(4)}`)
  for (const [key, su] of state.stepUsage) {
    const [tid, sid] = key.split('\u0000')
    if (tid !== id) continue
    console.log(`  step ${sid!.padEnd(22)} in=${fmt(su.inputTokens)} out=${fmt(su.outputTokens)} cacheRead=${fmt(su.cacheReadTokens ?? 0)} $${(su.costUSD ?? 0).toFixed(4)}`)
  }
}
const mins = firstTs && lastTs ? (new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 60_000 : 0
console.log(`\nTOTAL in=${fmt(inTok)} out=${fmt(outTok)} cacheRead=${fmt(cacheTok)} cost=$${cost.toFixed(4)}  iterations=${iterations}  wall=${mins.toFixed(1)}min`)
process.exit(0)
