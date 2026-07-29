// Scratch debug tail: a rich, timestamped live view of ONE task's events (payloads, not just
// kinds). Lives here (not /tmp) so it resolves the @orc/kernel workspace dep. Separate process
// from `orc run` — subscribes over the same event log via LISTEN/NOTIFY.
//   Run: bun packages/cli/src/debug-tail.ts <taskId>
import { loadConfig, openStorage, requireProject } from '@orc/kernel'
import { summarizeEvent } from '@orc/ui-core'
import type { EventRecord } from '@orc/contracts'

const taskId = process.argv[2]
if (!taskId) { console.error('usage: debug-tail <taskId>'); process.exit(1) }
// loadConfig is the ONE resolution of env → .orc/config.json → default (same as openKernel) — a
// re-spelled URL here ignored a config.json databaseUrl and tailed the wrong database.
const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })

const t0 = Date.now()
const clock = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8)

const unsub = await storage.events.subscribe({}, (e: EventRecord) => {
  if (e.taskId !== taskId && e.taskId !== null) return // this task + project-scoped (memory) events
  console.log(`${clock()}  ${String(e.seq).padStart(4)}  ${e.kind.padEnd(18)} ${(e.stepId ?? '·').padEnd(8)} ${summarizeEvent(e).line}`)
})
console.log(`debug-tail attached to ${taskId} (project ${config.projectId})`)
process.on('SIGINT', async () => { await unsub(); await storage.close(); process.exit(0) })
process.on('SIGTERM', async () => { await unsub(); await storage.close(); process.exit(0) })
