// Scratch debug tail: a rich, timestamped live view of ONE task's events (payloads, not just
// kinds). Lives here (not /tmp) so it resolves the @orc/kernel workspace dep. Separate process
// from `orc run` — subscribes over the same event log via LISTEN/NOTIFY.
//   Run: bun packages/cli/src/debug-tail.ts <taskId>
import { readFileSync } from 'node:fs'
import { openStorage } from '@orc/kernel'
import { summarizeEvent } from '@orc/ui-core'
import type { EventRecord } from '@orc/contracts'

const taskId = process.argv[2]
if (!taskId) { console.error('usage: debug-tail <taskId>'); process.exit(1) }
const projectId = (JSON.parse(readFileSync('.orc/config.json', 'utf8')) as { projectId: string }).projectId
const url = process.env.ORC_DATABASE_URL ?? 'postgresql://postgres:orc@localhost:5433/orc'
const storage = await openStorage(url, { projectId })

const t0 = Date.now()
const clock = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8)

const unsub = await storage.events.subscribe({}, (e: EventRecord) => {
  if (e.taskId !== taskId && e.taskId !== null) return // this task + project-scoped (memory) events
  console.log(`${clock()}  ${String(e.seq).padStart(4)}  ${e.kind.padEnd(18)} ${(e.stepId ?? '·').padEnd(8)} ${summarizeEvent(e).line}`)
})
console.log(`debug-tail attached to ${taskId} (project ${projectId})`)
process.on('SIGINT', async () => { await unsub(); await storage.close(); process.exit(0) })
process.on('SIGTERM', async () => { await unsub(); await storage.close(); process.exit(0) })
