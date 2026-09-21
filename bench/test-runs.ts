// How much test proof is repeated in the event log. Run: bun bench/test-runs.ts
import { z } from 'zod'
import { EVENT_KIND, PAYLOAD_SCHEMAS } from '../packages/contracts/src/index.ts'
import { CHECK_TOOL_NAME, EXEC_TOOL_NAME, loadConfig, openStorage, requireProject } from '../packages/kernel/src/index.ts'
import { commandArgv } from '../packages/kernel/src/execution/command-argv.ts'

const config = requireProject(loadConfig())
const storage = await openStorage(config.databaseUrl, { projectId: config.projectId })
const events = await storage.events.all()

const fmt = (n: number): string => n.toLocaleString('en-US')

const SEP = '\u0000'
const NULL_TASK_ID = '(null)'
const BUN_TEST_PREFIX = 'bun test'
const TEST_FILE_MARKER = '.test.'
const TOP_N_FILES = 15

type TestToolName = typeof EXEC_TOOL_NAME | typeof CHECK_TOOL_NAME

const CommandInput = z.object({ command: z.string() }).loose()
const ExecOutput = z.object({
  exitCode: z.number().int().optional(),
  cached: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  error: z.string().optional(),
}).loose()
const CheckOutput = z.object({
  pass: z.boolean().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).loose()

interface CallRec {
  seq: number
  ts: string
  taskId: string | null
  runToken: string
  toolCallId: string
  toolName: TestToolName
  command: string
}
interface ResultRec {
  seq: number
  ts: string
  isError: boolean
  execOut?: z.infer<typeof ExecOutput>
  checkOut?: z.infer<typeof CheckOutput>
}

function pushTo<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key)
  if (arr) arr.push(val)
  else map.set(key, [val])
}

const normalizeFile = (f: string): string => (f.startsWith('./') ? f.slice(2) : f)

function argvPartsOf(command: string): { files: string[]; flags: string[] } {
  const parsed = commandArgv(command)
  const rest = parsed.argv ? parsed.argv.slice(2) : command.split(/\s+/).slice(2)
  const files = rest.filter(t => t.includes(TEST_FILE_MARKER)).map(normalizeFile)
  const flags = rest.filter(t => !t.includes(TEST_FILE_MARKER))
  return { files, flags }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0)
}
function p90(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)
  return s[idx] ?? 0
}

const taskIds = new Set<string>()
const runTokens = new Set<string>()
let toolCallEvents = 0
let commitRecordedEvents = 0
for (const e of events) {
  if (e.taskId) taskIds.add(e.taskId)
  if (e.runToken) runTokens.add(e.runToken)
  if (e.kind === EVENT_KIND.tool_call) toolCallEvents += 1
  if (e.kind === EVENT_KIND.commit_recorded) commitRecordedEvents += 1
}
const firstTs = events[0]?.ts ?? null
const lastTs = events[events.length - 1]?.ts ?? null

console.log('=== 0. log span ===')
console.log(`first ts: ${firstTs}`)
console.log(`last ts:  ${lastTs}`)
console.log(`total events: ${fmt(events.length)}`)
console.log(`distinct taskIds: ${fmt(taskIds.size)}`)
console.log(`distinct runTokens: ${fmt(runTokens.size)}`)
console.log(`tool_call events: ${fmt(toolCallEvents)}`)
console.log(`commit_recorded events: ${fmt(commitRecordedEvents)}`)

const resultsByKey = new Map<string, ResultRec>()
for (const e of events) {
  if (e.kind !== EVENT_KIND.tool_result) continue
  const p = PAYLOAD_SCHEMAS.tool_result.parse(e.payload)
  if (p.toolName !== EXEC_TOOL_NAME && p.toolName !== CHECK_TOOL_NAME) continue
  const key = `${p.runToken}${SEP}${p.toolCallId}`
  const rec: ResultRec = { seq: e.seq, ts: e.ts, isError: p.isError }
  if (p.toolName === EXEC_TOOL_NAME) {
    const parsed = ExecOutput.safeParse(p.output)
    if (parsed.success) rec.execOut = parsed.data
  } else {
    const parsed = CheckOutput.safeParse(p.output)
    if (parsed.success) rec.checkOut = parsed.data
  }
  resultsByKey.set(key, rec)
}

const agentCallsByRunToken = new Map<string, Array<{ seq: number; ts: string }>>()
for (const e of events) {
  if (e.kind !== EVENT_KIND.agent_call) continue
  const p = PAYLOAD_SCHEMAS.agent_call.parse(e.payload)
  pushTo(agentCallsByRunToken, p.runToken, { seq: e.seq, ts: e.ts })
}
function latestEarlierAgentCall(runToken: string, beforeSeq: number): { seq: number; ts: string } | null {
  const arr = agentCallsByRunToken.get(runToken)
  if (!arr) return null
  let best: { seq: number; ts: string } | null = null
  for (const a of arr) {
    if (a.seq < beforeSeq && (best === null || a.seq > best.seq)) best = a
  }
  return best
}

const bunTestCalls: CallRec[] = []
let unpaired = 0
const byToolName = new Map<TestToolName, number>([[EXEC_TOOL_NAME, 0], [CHECK_TOOL_NAME, 0]])

for (const e of events) {
  if (e.kind !== EVENT_KIND.tool_call) continue
  const p = PAYLOAD_SCHEMAS.tool_call.parse(e.payload)
  if (p.toolName !== EXEC_TOOL_NAME && p.toolName !== CHECK_TOOL_NAME) continue
  const inputParsed = CommandInput.safeParse(p.input)
  if (!inputParsed.success) continue
  const { command } = inputParsed.data
  if (!command.startsWith(BUN_TEST_PREFIX)) continue
  bunTestCalls.push({ seq: e.seq, ts: e.ts, taskId: e.taskId, runToken: p.runToken, toolCallId: p.toolCallId, toolName: p.toolName, command })
  byToolName.set(p.toolName, (byToolName.get(p.toolName) ?? 0) + 1)
  if (!resultsByKey.has(`${p.runToken}${SEP}${p.toolCallId}`)) unpaired += 1
}

let cachedCount = 0
let timedOutCount = 0
const exitCodeDist = new Map<string, number>()
const checkPassDist = new Map<string, number>()
for (const c of bunTestCalls) {
  const r = resultsByKey.get(`${c.runToken}${SEP}${c.toolCallId}`)
  if (!r) continue
  if (c.toolName === EXEC_TOOL_NAME && r.execOut) {
    if (r.execOut.cached === true) cachedCount += 1
    if (r.execOut.timedOut === true) timedOutCount += 1
    const key = r.execOut.timedOut === true ? 'timedOut' : r.execOut.exitCode !== undefined ? String(r.execOut.exitCode) : r.execOut.error !== undefined ? 'error(no-argv)' : 'unknown'
    exitCodeDist.set(key, (exitCodeDist.get(key) ?? 0) + 1)
  } else if (c.toolName === CHECK_TOOL_NAME && r.checkOut) {
    const key = r.checkOut.pass === true ? 'pass' : r.checkOut.pass === false ? 'fail' : 'unknown'
    checkPassDist.set(key, (checkPassDist.get(key) ?? 0) + 1)
  }
}

type FileBucket = '0' | '1' | '2-5' | '>5'
const FILE_BUCKETS: readonly FileBucket[] = ['0', '1', '2-5', '>5']
function fileBucketOf(fileCount: number): FileBucket {
  if (fileCount === 0) return '0'
  if (fileCount === 1) return '1'
  return fileCount <= 5 ? '2-5' : '>5'
}
const fileBuckets = new Map<FileBucket, number>(FILE_BUCKETS.map(b => [b, 0]))
const distinctFlags = new Set<string>()
const perFileExec = new Map<string, { execs: number; runTokens: Set<string> }>()
let totalFileExecutions = 0

for (const c of bunTestCalls) {
  const { files, flags } = argvPartsOf(c.command)
  for (const f of flags) distinctFlags.add(f)
  const bucket = fileBucketOf(files.length)
  fileBuckets.set(bucket, (fileBuckets.get(bucket) ?? 0) + 1)
  totalFileExecutions += files.length
  for (const f of files) {
    const rec = perFileExec.get(f) ?? { execs: 0, runTokens: new Set<string>() }
    rec.execs += 1
    rec.runTokens.add(c.runToken)
    perFileExec.set(f, rec)
  }
}

console.log('\n=== 1. bun test invocations ===')
console.log(`total matched tool_calls: ${fmt(bunTestCalls.length)}  (exec=${fmt(byToolName.get(EXEC_TOOL_NAME) ?? 0)} check=${fmt(byToolName.get(CHECK_TOOL_NAME) ?? 0)})`)
console.log(`unpaired calls (no matching tool_result): ${fmt(unpaired)}`)
console.log(`cached:true results (exec only): ${fmt(cachedCount)}`)
console.log(`timedOut results (exec only): ${fmt(timedOutCount)}`)
console.log(`exit-code distribution (exec outputs, by exitCode/timedOut/error):`)
for (const [k, v] of [...exitCodeDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${fmt(v)}`)
console.log(`check pass/fail distribution (check has no exitCode field):`)
for (const [k, v] of [...checkPassDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${fmt(v)}`)

console.log('\n=== 2. files per command ===')
for (const b of FILE_BUCKETS) console.log(`  ${b.padEnd(4)} files: ${fmt(fileBuckets.get(b) ?? 0)}`)
console.log(`distinct flags seen (${distinctFlags.size}):`)
for (const f of [...distinctFlags].sort()) console.log(`  ${JSON.stringify(f)}`)

console.log('\n=== 3. per test file ===')
console.log(`total file-executions (a 3-file command counts 3): ${fmt(totalFileExecutions)}`)
console.log(`distinct files: ${fmt(perFileExec.size)}`)
const topFiles = [...perFileExec.entries()].sort((a, b) => b[1].execs - a[1].execs).slice(0, TOP_N_FILES)
console.log(`top ${TOP_N_FILES} by executions:`)
console.log(`  ${'file'.padEnd(55)} execs  distinctRunTokens`)
for (const [file, rec] of topFiles) console.log(`  ${file.padEnd(55)} ${String(rec.execs).padEnd(6)} ${rec.runTokens.size}`)

function repeatStats(groups: Map<string, CallRec[]>): { repeats: number; cachedRepeats: number } {
  let repeats = 0
  let cachedRepeats = 0
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => a.seq - b.seq)
    for (let i = 1; i < sorted.length; i++) {
      repeats += 1
      const c = sorted[i]
      if (!c) continue
      const r = resultsByKey.get(`${c.runToken}${SEP}${c.toolCallId}`)
      if (r?.execOut?.cached === true) cachedRepeats += 1
    }
  }
  return { repeats, cachedRepeats }
}

const byRunToken = new Map<string, CallRec[]>()
const byTaskId = new Map<string, CallRec[]>()
const byCommandOnly = new Map<string, CallRec[]>()
for (const c of bunTestCalls) {
  pushTo(byRunToken, `${c.runToken}${SEP}${c.command}`, c)
  pushTo(byTaskId, `${c.taskId ?? NULL_TASK_ID}${SEP}${c.command}`, c)
  pushTo(byCommandOnly, c.command, c)
}
const repA = repeatStats(byRunToken)
const repB = repeatStats(byTaskId)
const repC = repeatStats(byCommandOnly)

console.log('\n=== 4. exact repeats (same command string) ===')
console.log(`(a) within one runToken:  repeats=${fmt(repA.repeats)}  served cached:true=${fmt(repA.cachedRepeats)}`)
console.log(`(b) within one taskId:    repeats=${fmt(repB.repeats)}  served cached:true=${fmt(repB.cachedRepeats)}`)
console.log(`(c) across whole log:     repeats=${fmt(repC.repeats)}  served cached:true=${fmt(repC.cachedRepeats)}`)

interface Dur { ms: number; call: CallRec }
const durations: Dur[] = []
let unmeasurable = 0
for (const c of bunTestCalls) {
  const r = resultsByKey.get(`${c.runToken}${SEP}${c.toolCallId}`)
  if (!r) continue
  if (c.toolName === EXEC_TOOL_NAME) {
    const ac = latestEarlierAgentCall(c.runToken, r.seq)
    if (!ac) { unmeasurable += 1; continue }
    durations.push({ ms: new Date(r.ts).getTime() - new Date(ac.ts).getTime(), call: c })
  } else {
    const startedAt = r.checkOut?.startedAt
    const endedAt = r.checkOut?.endedAt
    if (!startedAt || !endedAt) { unmeasurable += 1; continue }
    durations.push({ ms: new Date(endedAt).getTime() - new Date(startedAt).getTime(), call: c })
  }
}

const allMs = durations.map(d => d.ms)
const sumMinutes = allMs.reduce((a, b) => a + b, 0) / 60_000
const medianSec = median(allMs) / 1000
const p90Sec = p90(allMs) / 1000

const repeatKeysB = new Set<string>()
for (const list of byTaskId.values()) {
  if (list.length < 2) continue
  const sorted = [...list].sort((a, b) => a.seq - b.seq)
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i]
    if (c) repeatKeysB.add(`${c.runToken}${SEP}${c.toolCallId}`)
  }
}
let repeatBMs = 0
let repeatBCount = 0
for (const d of durations) {
  if (repeatKeysB.has(`${d.call.runToken}${SEP}${d.call.toolCallId}`)) { repeatBMs += d.ms; repeatBCount += 1 }
}

let cachedMs = 0
let cachedMeasured = 0
for (const d of durations) {
  const r = resultsByKey.get(`${d.call.runToken}${SEP}${d.call.toolCallId}`)
  if (r?.execOut?.cached === true) { cachedMs += d.ms; cachedMeasured += 1 }
}

console.log('\n=== 5. duration ===')
console.log(`method: exec = ts(tool_result) - ts(latest earlier agent_call, same runToken, by seq); check = endedAt - startedAt`)
console.log(`measurable runs: ${fmt(durations.length)}  (unmeasurable: ${fmt(unmeasurable)} — no preceding agent_call in runToken, or missing startedAt/endedAt)`)
console.log(`sum over all bun-test runs: ${sumMinutes.toFixed(1)} min`)
console.log(`median per run: ${medianSec.toFixed(1)}s   p90 per run: ${p90Sec.toFixed(1)}s`)
console.log(`sum for (4b) repeat occurrences: ${(repeatBMs / 60_000).toFixed(1)} min  over ${fmt(repeatBCount)} measured repeats`)
console.log(`sum for cached:true results: ${(cachedMs / 60_000).toFixed(2)} min  over ${fmt(cachedMeasured)} measured cached results (approx should be ~0)`)

interface CommitEv { seq: number; paths: string[] }
const commits: CommitEv[] = []
for (const e of events) {
  if (e.kind !== EVENT_KIND.commit_recorded) continue
  const p = PAYLOAD_SCHEMAS.commit_recorded.parse(e.payload)
  commits.push({ seq: e.seq, paths: p.paths })
}
commits.sort((a, b) => a.seq - b.seq)

function packageDirOf(file: string): string {
  const m = /^((?:packages|plugins)\/[^/]+)\//.exec(file)
  if (m?.[1]) return `${m[1]}/`
  const idx = file.lastIndexOf('/')
  return idx === -1 ? file : `${file.slice(0, idx)}/`
}

interface FileExec { seq: number; green: boolean }
const execsByTaskFile = new Map<string, FileExec[]>()
for (const c of bunTestCalls) {
  const { files } = argvPartsOf(c.command)
  if (files.length === 0) continue
  const r = resultsByKey.get(`${c.runToken}${SEP}${c.toolCallId}`)
  if (!r) continue
  let green = false
  let cached = false
  if (c.toolName === EXEC_TOOL_NAME && r.execOut) {
    green = r.execOut.exitCode === 0 && r.execOut.timedOut !== true
    cached = r.execOut.cached === true
  } else if (c.toolName === CHECK_TOOL_NAME && r.checkOut) {
    green = r.checkOut.pass === true
  }
  const isGreenNonCached = green && !cached
  for (const f of files) pushTo(execsByTaskFile, `${c.taskId ?? NULL_TASK_ID}${SEP}${f}`, { seq: c.seq, green: isGreenNonCached })
}

let touchedFileItself = 0
let touchedSamePackage = 0
let touchedElsewhereOnly = 0
let noCommitAtAll = 0

for (const [key, list] of execsByTaskFile.entries()) {
  const [, file] = key.split(SEP)
  if (file === undefined) continue
  const pkgDir = packageDirOf(file)
  const sorted = [...list].sort((a, b) => a.seq - b.seq)
  let lastGreenSeq: number | null = null
  for (const exec of sorted) {
    if (lastGreenSeq !== null) {
      const windowCommits = commits.filter(cm => cm.seq > (lastGreenSeq ?? -1) && cm.seq < exec.seq)
      if (windowCommits.length === 0) noCommitAtAll += 1
      else if (windowCommits.some(cm => cm.paths.includes(file))) touchedFileItself += 1
      else if (windowCommits.some(cm => cm.paths.some(p => p.startsWith(pkgDir)))) touchedSamePackage += 1
      else touchedElsewhereOnly += 1
    }
    if (exec.green) lastGreenSeq = exec.seq
  }
}

const qualifying = touchedFileItself + touchedSamePackage + touchedElsewhereOnly + noCommitAtAll
console.log('\n=== 6. commit-between-runs proxy ===')
console.log('PROXY ONLY: paths touched vs. the same package dir/file — not the real import closure.')
console.log(`qualifying "repeats an earlier green" instances: ${fmt(qualifying)}  (of ${fmt(totalFileExecutions)} total file-executions)`)
console.log(`${'(a) touched the test file itself:'.padEnd(42)} ${fmt(touchedFileItself)}`)
console.log(`${'(b) touched same package dir, not file:'.padEnd(42)} ${fmt(touchedSamePackage)}`)
console.log(`${'(c) touched only paths elsewhere:'.padEnd(42)} ${fmt(touchedElsewhereOnly)}`)
console.log(`${'(d) no commit_recorded at all in window:'.padEnd(42)} ${fmt(noCommitAtAll)}`)

console.log('\ndone.')
process.exit(0)
