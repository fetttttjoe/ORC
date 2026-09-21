/**
 * `svelte-check` over the browser app, with vendored noise filtered out so the result can gate CI.
 * Two tsconfigs, run sequentially: `tsconfig.json` (DOM, app code) and `tsconfig.test.json`
 * (DOM+Bun, tests) — one tsconfig for both used to type app code against Bun's `fetch`.
 *
 * Why a wrapper and not config alone: the 28 errors upstream shadcn-svelte produces under
 * `exactOptionalPropertyTypes` live inside `src/lib/components/ui/**`, which this repo never edits
 * (the customization order is variants → class → new variant → wrapper), and svelte-check's
 * `--ignore` refuses to run alongside `--tsconfig`, which is where the strict options live. So the
 * filter belongs at the reporting layer.
 *
 * Filtering the FILE, not the message: an error inside a vendored component is upstream's; an
 * error at a first-party call site that misuses one is ours and still fails here.
 */
const WEB_DIR = new URL('../packages/graph-ui/web/', import.meta.url).pathname

/** the vendored tree, spelled once — svelte-check reports paths relative to the web app root */
const VENDORED_UI_PREFIX = 'src/lib/components/ui/'

const TSCONFIGS = ['./tsconfig.json', './tsconfig.test.json']

// svelte-check --output machine emits one record per line:
//   <epoch-ms> ERROR "<file>" <line>:<col> "<message>"
// and closes with `<epoch-ms> COMPLETED <n> FILES <n> ERRORS <n> WARNINGS <n> FILES_WITH_PROBLEMS`.
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

// A filter that reports "0 errors" when the checker never ran is a false green, and it fails in the
// direction nobody looks. svelte-check's exit code cannot carry this on its own — it exits non-zero
// whenever errors exist, which is a normal outcome here — so the COMPLETED record is the proof each
// pass finished. No record, no verdict.
let failed = false
for (const r of results) {
  if (!r.completed) {
    console.error(`svelte-check (${r.tsconfig}) did not finish (exit ${r.exitCode}) — no COMPLETED record. Its stderr is above.`)
    if (r.tail !== '') console.error(r.tail.split('\n').slice(-5).join('\n'))
    failed = true
    continue
  }
  // State the filtered count rather than dropping it silently: a jump after a `shadcn-svelte
  // update` is the signal to re-read what upstream changed.
  console.log(`svelte-check (${r.tsconfig}): ${r.ours.length} first-party error(s); ${r.vendored} suppressed in ${VENDORED_UI_PREFIX} (vendored)`)
  for (const line of r.ours) console.log(line)
  if (r.ours.length > 0) failed = true
}
process.exit(failed ? 1 : 0)
