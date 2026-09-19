import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage, toolError, type ResolvedTool } from '@orc/contracts'
import { childEnv } from './child-env'
import { clipMiddle } from './clip'
import { treeFingerprint } from './tree-fingerprint'
import { commandArgv } from './command-argv'

// exec: the acceptance-gate tool. Plans routinely demand "typecheck clean,
// tests green", but no step could RUN anything — implementers shipped unexecuted (red) suites
// and the honest auditor's only move was to refuse certification, which is exactly how
// a verify step burned four times. Mirrors report_coverage's factory shape.
//
// Trust model: the COMMANDS come from the operator (config execAllowlist), never the model —
// the model only picks an entry and may extend it with arguments at a token boundary
// ('bun test' allows 'bun test src/x.test.ts', never 'bun testx'). No shell is involved: the
// command splits on whitespace and spawns directly, so shell metacharacters (;, &&, |, $())
// are inert argv tokens the target program rejects, not chaining.
//
// The allowlisted command still RUNS model-authored code (a `bun test` executes the tests the
// step just wrote), so it is not a security sandbox: it inherits neither the orchestrator's
// secrets (env is scrubbed to a minimal surface, see child-env.ts)
// nor a write fence (cwd is the workspace, but the command can write anywhere). ponytail: the
// real containment is the deferred M5c per-step isolation (worktree/container); until it lands,
// enabling execAllowlist grants the model host code execution, and exec is off unless configured.
const ExecInput = z.object({ command: z.string().min(1) })

// ponytail: fixed caps — promote to config when a real suite outgrows them
const TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 5_000 // SIGTERM → wait → SIGKILL, so a child that ignores SIGTERM still dies
// How long after the child EXITS we still wait for its stdio to close. Long enough that the normal
// path reports complete output through 'close'; short enough that an orphaned grandchild holding
// the pipes cannot hang the tool. Not a tuning knob — a liveness floor.
const EXIT_FLUSH_MS = 250
const CLIP_CHARS = 8_000 // per stream, head + tail: typecheck errors lead, test summaries trail
const MAX_BYTES = 64 * 1024 * 1024 // per stream, matches the old spawnSync maxBuffer

const clip = (s: string): string => clipMiddle(s, CLIP_CHARS)

const killedAtCeiling = (ms: number): string => `killed at the ${ms / 1000}s ceiling`

const hangError = (ms: number): string =>
  `command HUNG and was ${killedAtCeiling(ms)} — it is not merely slow: the last lines of stdout/stderr name what never finished, and the full streams are in logPath. Re-running the same files with other flags hangs again; narrow to that one test or signal what you have.`

// Where the FULL streams land, workspace-relative so fs_read can reach them. `.orc/*` is
// gitignored, so a gate log never rides along in a commit.
const LOG_DIR = path.join('.orc', 'exec')
// How long a recorded result may stand in for a re-run of the identical command on an identical
// tree. Bounded because the fingerprint covers the TREE and nothing else: a suite also depends on
// Postgres/Surreal/network, and those can move without any file changing.
const REUSE_TTL_MS = 15 * 60_000

interface Recorded { exitCode: number; stdout: string; stderr: string; logPath: string; ranAt: number }
// Per (workspace, command, tree) — module-level so sibling steps in one wave share it.
const recorded = new Map<string, Recorded>()

// tree identity, shared with the memory health probe's drift cache — see tree-fingerprint.ts
const gitFingerprint = (dir: string) => (): Promise<string | null> => treeFingerprint(dir)

export function execTool(opts: {
  workspaceDir: string
  allowlist: string[]
  /** tree identity for reuse; injected in tests, git-derived otherwise. null disables reuse. */
  fingerprint?: () => Promise<string | null>
  /** the hang ceiling; injected in tests so it is reachable without a ten-minute wait. */
  timeoutMs?: number
}): ResolvedTool[] {
  const { workspaceDir, allowlist } = opts
  const fingerprint = opts.fingerprint ?? gitFingerprint(workspaceDir)
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  // registration gate: no allowlist, no tool — a tool that can only ever error is never offered
  if (allowlist.length === 0) return []
  return [{
    ref: 'kernel/exec', name: 'exec',
    description:
      `Run one allowlisted command in the step workspace and get {exitCode, stdout, stderr} back. Allowed: ${allowlist.map(a => `'${a}'`).join(', ')} — arguments may be appended. There is NO shell: one command, run from the workspace root — no cd, no pipes, no && chaining, no globs; quoted arguments ARE honoured, so a pattern with spaces works (grep -n \"export const X\" file.ts); pass paths as arguments (e.g. 'bun test packages/x/src/y.test.ts'). A non-zero exitCode is a result to read and report, not a tool failure. Use this to actually execute acceptance gates (tests, typecheck) instead of deferring them downstream. stdout/stderr are CLIPPED head+tail; the FULL output is written to the returned logPath — fs_read that instead of re-running to see the middle. cached:true means an identical command already ran against this exact tree and its recorded result is being reused. A run ${killedAtCeiling(timeoutMs)} returns what it printed so far plus timedOut:true — read those lines, it is a hang.`,
    inputSchema: {
      type: 'object', required: ['command'],
      properties: { command: { type: 'string', description: 'an allowlisted command, optionally extended with arguments' } },
    },
    execute: async input => {
      const parsed = ExecInput.safeParse(input)
      if (!parsed.success)
        return { output: { error: `invalid exec input: ${errorMessage(parsed.error)}` }, isError: true }
      const { command } = parsed.data
      if (!allowlist.some(a => command === a || command.startsWith(`${a} `))) {
        // a compound refusal teaches the rule, not just the list: agents raised in shells try
        // `cd X && bun test … | tail` (observed live) and should learn in ONE iteration that
        // exec spawns argv directly from the workspace root
        const compound = /(^|\s)cd\s|&&|\|\|?|;|>|</.test(command)
        const hint = compound
          ? ' — this tool has no shell: one command, run from the workspace root; no cd, no pipes, no chaining; pass paths as arguments'
          : ''
        return { output: { error: `command not allowlisted: '${command}'${hint} — allowed: ${allowlist.join(', ')} (operator-set: execAllowlist in .orc/config.json)` }, isError: true }
      }
      // The BRACKET: sibling steps in one wave each ran the same gate against the same unchanged
      // tree, paying the full suite every time. Reuse is reported, never silent.
      const tree = await fingerprint()
      const key = tree === null ? null : `${workspaceDir}\u0000${command}\u0000${tree}`
      const hit = key === null ? undefined : recorded.get(key)
      if (hit && Date.now() - hit.ranAt < REUSE_TTL_MS)
        return { output: { exitCode: hit.exitCode, stdout: hit.stdout, stderr: hit.stderr, logPath: hit.logPath, cached: true, ranAt: new Date(hit.ranAt).toISOString() }, isError: false }
      const logPath = path.join(LOG_DIR, `${createHash('sha256').update(key ?? command).digest('hex').slice(0, 16)}.log`)
      // quote-aware, so a multi-word argument survives as ONE token; still no shell
      const parsed2 = commandArgv(command)
      if (parsed2.error !== undefined)
        return { output: { error: `cannot parse command: ${parsed2.error}` }, isError: true }
      const argv = parsed2.argv
      // async spawn (not spawnSync): the whole orchestrator is one process running DBOS, the event
      // pump, the projectors and every parallel step's model loop — a synchronous wait would freeze
      // all of them for the command's full duration. Awaiting the child keeps the loop live.
      return await new Promise<{ output: Record<string, unknown>; isError: boolean }>(resolve => {
        let settled = false
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        let exitTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (r: { output: Record<string, unknown>; isError: boolean }) => {
          if (settled) return
          settled = true
          clearTimeout(killTimer)
          if (graceTimer) clearTimeout(graceTimer)
          if (exitTimer) clearTimeout(exitTimer)
          resolve(r)
        }
        // `bin`, not `command`: destructuring into `command` shadowed the full command string the
        // log header names, and the header then read `$ sh` for `sh noisy.sh`.
        const [bin, ...rest] = argv
        if (bin === undefined) return finish({ output: { error: 'empty command' }, isError: true })
        const child = spawn(bin, rest, { cwd: workspaceDir, env: childEnv() })
        let stdout = '', stderr = '', timedOut = false
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', d => { if (stdout.length < MAX_BYTES) stdout += d })
        child.stderr.on('data', d => { if (stderr.length < MAX_BYTES) stderr += d })
        // a stream 'error' with no listener throws as an UNHANDLED error (e.g. EPIPE when we SIGKILL
        // a child mid-write) — funnel it to finish so it can never crash the process; the 'close'
        // handler still wins on the normal path via the `settled` guard.
        const onStreamError = (e: Error): void => finish(toolError(e))
        child.stdout.on('error', onStreamError)
        child.stderr.on('error', onStreamError)
        // enforceable timeout: SIGTERM, then SIGKILL after a grace — spawnSync's timeout only sent
        // SIGTERM, so a child ignoring it blocked past the timeout (indefinitely).
        const killTimer = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          graceTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        }, timeoutMs)
        child.on('error', e => finish(toolError(e)))
        // The clip is head+tail, so anything in the MIDDLE is unreachable and an agent that needed
        // one line from there had to re-run the whole suite. Full streams go to a file instead.
        const report = (ending: { exitCode: number } | { killedAtCeiling: true }): { output: Record<string, unknown>; isError: boolean } => {
          const killed = 'killedAtCeiling' in ending
          const status = killed ? killedAtCeiling(timeoutMs) : `exit ${ending.exitCode}`
          try {
            mkdirSync(path.join(workspaceDir, LOG_DIR), { recursive: true })
            writeFileSync(path.join(workspaceDir, logPath), `$ ${command}\n${status}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`)
          } catch { /* advisory: losing the log must never fail the command it describes */ }
          const streams = { stdout: clip(stdout), stderr: clip(stderr), logPath }
          // a hang can be environmental; `recorded` stands in for settled results only
          if (killed) return { output: { timedOut: true, ...streams, error: hangError(timeoutMs) }, isError: true }
          const out = { exitCode: ending.exitCode, ...streams }
          if (key !== null) recorded.set(key, { ...out, ranAt: Date.now() })
          return { output: out, isError: false }
        }
        const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (timedOut) return finish(report({ killedAtCeiling: true }))
          // an external signal (e.g. an OOM SIGKILL) is a real failure, but NOT a timeout — report it as itself
          if (signal) return finish({ output: { error: `command killed by ${signal}` }, isError: true })
          finish(report({ exitCode: code ?? -1 }))
        }
        child.on('close', settle)
        // 'close' waits for the stdio STREAMS to end, not for the process to exit — so a command
        // that leaves a grandchild holding the inherited pipes (a background server a test suite
        // starts and does not reap) exits while the only resolution path never fires. The timeout
        // could not rescue it either: it kills the CHILD, and the grandchild still holds the pipes,
        // so the tool hung forever with `bun test` — which is on the default execAllowlist.
        //
        // 'exit' is the process-level truth. Give the streams a brief grace to flush so the normal
        // path still reports full output via 'close' (finish's `settled` guard makes whichever
        // lands first the winner), then settle on what we have.
        child.on('exit', (code, signal) => {
          exitTimer = setTimeout(() => settle(code, signal), EXIT_FLUSH_MS)
        })
      })
    },
  }]
}
