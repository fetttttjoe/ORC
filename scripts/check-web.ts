/** --ignore cannot combine with --tsconfig, so vendored files are filtered here; ours still fail CI */
const WEB_DIR = new URL('../packages/graph-ui/web/', import.meta.url).pathname

/** the vendored tree, spelled once — svelte-check reports paths relative to the web app root */
const VENDORED_UI_PREFIX = 'src/lib/components/ui/'

// app code is typed against the DOM only; tests get their own config with Bun's types
const TSCONFIGS = ['./tsconfig.json', './tsconfig.test.json']

// svelte-check --output machine: `<epoch-ms> ERROR "<file>" <line>:<col> "<message>"` per line
const DIAGNOSTIC = /^\d+ (ERROR|WARNING) "([^"]+)" (\d+:\d+) "(.*)"$/
const COMPLETED = /^\d+ COMPLETED \d+ FILES \d+ ERRORS/

interface PassResult {
  tsconfig: string
  completed: boolean
  exitCode: number
  tail: string
  ours: string[]
  vendored: number
}

async function runPass(tsconfig: string): Promise<PassResult> {
  const proc = Bun.spawn(
    ['bunx', 'svelte-check', '--tsconfig', tsconfig, '--tsgo', '--threshold', 'error', '--output', 'machine'],
    { cwd: WEB_DIR, stdout: 'pipe', stderr: 'inherit' },
  )
  const raw = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  const ours: string[] = []
  let vendored = 0
  let completed = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (COMPLETED.test(trimmed)) { completed = true; continue }
    const m = DIAGNOSTIC.exec(trimmed)
    if (!m) continue
    const [, severity, file, at, message] = m
    if (file === undefined) continue
    if (file.startsWith(VENDORED_UI_PREFIX)) { vendored += 1; continue }
    ours.push(`${severity} ${file}:${at} — ${message}`)
  }
  return { tsconfig, completed, exitCode, tail: raw.trim(), ours, vendored }
}

// sequential, not Promise.all — measured: concurrent --tsgo runs under-report each other's errors
const results: PassResult[] = []
for (const tsconfig of TSCONFIGS) results.push(await runPass(tsconfig))

// no COMPLETED record, no verdict: svelte-check's exit code cannot prove each pass finished
let failed = false
for (const r of results) {
  if (!r.completed) {
    console.error(`svelte-check (${r.tsconfig}) did not finish (exit ${r.exitCode}) — no COMPLETED record. Its stderr is above.`)
    if (r.tail !== '') console.error(r.tail.split('\n').slice(-5).join('\n'))
    failed = true
    continue
  }
  // state the filtered count: a jump after a shadcn-svelte update means re-read what changed
  console.log(`svelte-check (${r.tsconfig}): ${r.ours.length} first-party error(s); ${r.vendored} suppressed in ${VENDORED_UI_PREFIX} (vendored)`)
  for (const line of r.ours) console.log(line)
  if (r.ours.length > 0) failed = true
}
process.exit(failed ? 1 : 0)
