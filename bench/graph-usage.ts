// How the knowledge graph folded out during a task: which notes were pulled and
// written, by which step. Run: bun bench/graph-usage.ts <taskId-prefix>
// ponytail: relative imports — bench/ is not a workspace package and doesn't need to be
import { loadConfig, openStorage, requireProject } from '../packages/kernel/src/index.ts'

const prefix = process.argv[2]
if (!prefix) { console.error('usage: bun bench/graph-usage.ts <taskId-prefix>'); process.exit(2) }

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const events = await storage.events.after(0, ['memory_accessed', 'memory_written'])

type Row = { step: string; kind: string; note: string; detail: string }
const rows: Row[] = []
for (const e of events) {
  if (e.kind === 'memory_accessed') {
    if (!e.taskId?.startsWith(prefix)) continue // envelope-bound to the acting step
    const p = e.payload as { id: string; scope: string; mode: string }
    rows.push({ step: e.stepId ?? '?', kind: `pull:${p.mode}`, note: `${p.scope}/${p.id}`, detail: '' })
  } else {
    const p = e.payload as { note: { id: string; scope: string; body?: string; links?: unknown[] }; author: { taskId?: string | null } }
    if (!p.author?.taskId?.startsWith(prefix)) continue // writes carry the author, not the envelope
    rows.push({ step: '(author)', kind: 'write', note: `${p.note.scope}/${p.note.id}`, detail: `${(p.note.body ?? '').length}ch ${(p.note.links ?? []).length} links` })
  }
}

if (!rows.length) console.log(`no memory activity for task prefix '${prefix}'`)
const counts = new Map<string, number>()
for (const r of rows) {
  counts.set(`${r.kind} ${r.note}`, (counts.get(`${r.kind} ${r.note}`) ?? 0) + 1)
  console.log(`${r.step.padEnd(20)} ${r.kind.padEnd(16)} ${r.note}  ${r.detail}`)
}
console.log(`\ntotals: ${rows.length} events, ${counts.size} distinct (kind,note) pairs`)
process.exit(0)
