import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage, type ResolvedTool } from '@orc/contracts'
import { treeFingerprint } from './tree-fingerprint'
import { commandArgv } from './command-argv'
import { COMMAND_TIMEOUT_MS, killedAtCeiling, runCommand } from './run-command'

const ExecInput = z.object({ command: z.string().min(1) })

// Workspace-relative so fs_read reaches the full streams; .orc/* is gitignored, never committed.
const LOG_DIR = path.join('.orc', 'exec')
// Bounded: the fingerprint covers the tree only; a suite also depends on Postgres and network.
const REUSE_TTL_MS = 15 * 60_000

export const EXEC_TOOL_NAME = 'exec'

interface Recorded { exitCode: number; stdout: string; stderr: string; logPath: string; ranAt: number }
// Per (workspace, command, tree) — module-level so sibling steps in one wave share it.
const recorded = new Map<string, Recorded>()

const gitFingerprint = (dir: string) => (): Promise<string | null> => treeFingerprint(dir)

// Not a sandbox: allowlisted commands run model-written code; exec is off unless configured.
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
    ref: 'kernel/exec', name: EXEC_TOOL_NAME,
    description:
      `Run one allowlisted command in the step workspace and get {exitCode, stdout, stderr} back. Allowed: ${allowlist.map(a => `'${a}'`).join(', ')} — arguments may be appended. There is NO shell: one command, run from the workspace root — no cd, no pipes, no && chaining, no globs; quoted arguments ARE honoured, so a pattern with spaces works (grep -n \"export const X\" file.ts); pass paths as arguments (e.g. 'bun test packages/x/src/y.test.ts'). A non-zero exitCode is a result to read and report, not a tool failure. Use this to actually execute acceptance gates (tests, typecheck) instead of deferring them downstream. For tests, run the files you changed or 'bun test --changed' (the test files reachable from your uncommitted edits through RELATIVE imports — it does not follow bare @orc/* package imports, so also name the test files of every other package you touched); the whole suite is the operator's gate, not a step's. stdout/stderr are CLIPPED head+tail; the FULL output is written to the returned logPath — fs_read that instead of re-running to see the middle. cached:true means an identical command already ran against this exact tree and its recorded result is being reused. A run ${killedAtCeiling(timeoutMs)} returns what it printed so far plus timedOut:true — read those lines, it is a hang.`,
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
        // A compound refusal teaches the rule: shell-raised agents try `cd X && … | tail`.
        const compound = /(^|\s)cd\s|&&|\|\|?|;|>|</.test(command)
        const hint = compound
          ? ' — this tool has no shell: one command, run from the workspace root; no cd, no pipes, no chaining; pass paths as arguments'
          : ''
        return { output: { error: `command not allowlisted: '${command}'${hint} — allowed: ${allowlist.join(', ')} (operator-set: execAllowlist in .orc/config.json)` }, isError: true }
      }
      // Sibling steps in one wave ran the same gate on the same tree; reuse is reported, never silent.
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
