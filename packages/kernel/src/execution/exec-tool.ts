import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage, type ResolvedTool } from '@orc/contracts'
import { treeFingerprint } from './tree-fingerprint'
import { commandArgv } from './command-argv'
import { COMMAND_TIMEOUT_MS, killedAtCeiling, runCommand } from './run-command'

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
  const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS
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
      const result = await runCommand({ argv: parsed2.argv, command, cwd: workspaceDir, timeoutMs, logPath })
      if ('failed' in result) return { output: { error: result.error }, isError: true }
      if ('timedOut' in result)
        return { output: { timedOut: true, stdout: result.stdout, stderr: result.stderr, logPath: result.logPath, error: result.error }, isError: true }
      const out = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, logPath: result.logPath }
      if (key !== null) recorded.set(key, { ...out, ranAt: Date.now() })
      return { output: out, isError: false }
    },
  }]
}
