import { spawn } from 'node:child_process'
import { z } from 'zod'
import { errorMessage, type ResolvedTool } from '@orc/contracts'

// exec (post-scenario-2): the acceptance-gate tool. Plans routinely demand "typecheck clean,
// tests green", but no step could RUN anything — implementers shipped unexecuted (red) suites
// and the honest auditor's only move was to refuse certification, which is exactly how
// scenario-2's verify step failed four times. Mirrors report_coverage's factory shape.
//
// Trust model: the COMMANDS come from the operator (config execAllowlist), never the model —
// the model only picks an entry and may extend it with arguments at a token boundary
// ('bun test' allows 'bun test src/x.test.ts', never 'bun testx'). No shell is involved: the
// command splits on whitespace and spawns directly, so shell metacharacters (;, &&, |, $())
// are inert argv tokens the target program rejects, not chaining.
//
// The allowlisted command still RUNS model-authored code (a `bun test` executes the tests the
// step just wrote), so it is not a security sandbox: it inherits neither the orchestrator's
// secrets (env is scrubbed to a minimal surface below, like mcp-client does for its children)
// nor a write fence (cwd is the workspace, but the command can write anywhere). ponytail: the
// real containment is the deferred M5c per-step isolation (worktree/container); until it lands,
// enabling execAllowlist grants the model host code execution, and exec is off unless configured.
const ExecInput = z.object({ command: z.string().min(1) })

// ponytail: fixed caps — promote to config when a real suite outgrows them
const TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 5_000 // SIGTERM → wait → SIGKILL, so a child that ignores SIGTERM still dies
const CLIP_CHARS = 8_000 // per stream, head + tail: typecheck errors lead, test summaries trail
const MAX_BYTES = 64 * 1024 * 1024 // per stream, matches the old spawnSync maxBuffer

const clip = (s: string): string =>
  s.length <= 2 * CLIP_CHARS
    ? s
    : `${s.slice(0, CLIP_CHARS)}\n… [${s.length - 2 * CLIP_CHARS} chars omitted] …\n${s.slice(-CLIP_CHARS)}`

// Never the orchestrator's full process.env: provider API keys and DB credentials live there and
// must not reach model-authored code the command executes. A minimal surface (PATH to find the
// binary, HOME for tool caches, locale/tmp) — mirror of mcp-client's child-env policy.
const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'])
    if (process.env[k] !== undefined) out[k] = process.env[k]
  return out
}

export function execTool(opts: { workspaceDir: string; allowlist: string[] }): ResolvedTool[] {
  const { workspaceDir, allowlist } = opts
  // registration gate: no allowlist, no tool — a tool that can only ever error is never offered
  if (allowlist.length === 0) return []
  return [{
    ref: 'kernel/exec', name: 'exec',
    description:
      `Run one allowlisted command in the step workspace and get {exitCode, stdout, stderr} back. Allowed: ${allowlist.map(a => `'${a}'`).join(', ')} — arguments may be appended. A non-zero exitCode is a result to read and report, not a tool failure. Use this to actually execute acceptance gates (tests, typecheck) instead of deferring them downstream.`,
    inputSchema: {
      type: 'object', required: ['command'],
      properties: { command: { type: 'string', description: 'an allowlisted command, optionally extended with arguments' } },
    },
    execute: async input => {
      const parsed = ExecInput.safeParse(input)
      if (!parsed.success)
        return { output: { error: `invalid exec input: ${errorMessage(parsed.error)}` }, isError: true }
      const { command } = parsed.data
      if (!allowlist.some(a => command === a || command.startsWith(`${a} `)))
        return { output: { error: `command not allowlisted: '${command}' — allowed: ${allowlist.join(', ')} (operator-set: execAllowlist in .orc/config.json)` }, isError: true }
      const argv = command.split(/\s+/).filter(Boolean)
      // async spawn (not spawnSync): the whole orchestrator is one process running DBOS, the event
      // pump, the projectors and every parallel step's model loop — a synchronous wait would freeze
      // all of them for the command's full duration. Awaiting the child keeps the loop live.
      return await new Promise<{ output: Record<string, unknown>; isError: boolean }>(resolve => {
        let settled = false
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (r: { output: Record<string, unknown>; isError: boolean }) => {
          if (settled) return
          settled = true
          clearTimeout(killTimer)
          if (graceTimer) clearTimeout(graceTimer)
          resolve(r)
        }
        const child = spawn(argv[0]!, argv.slice(1), { cwd: workspaceDir, env: childEnv() })
        let stdout = '', stderr = '', timedOut = false
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', d => { if (stdout.length < MAX_BYTES) stdout += d })
        child.stderr.on('data', d => { if (stderr.length < MAX_BYTES) stderr += d })
        // enforceable timeout: SIGTERM, then SIGKILL after a grace — spawnSync's timeout only sent
        // SIGTERM, so a child ignoring it blocked past the timeout (indefinitely).
        const killTimer = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          graceTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        }, TIMEOUT_MS)
        child.on('error', e => finish({ output: { error: errorMessage(e) }, isError: true }))
        child.on('close', (code, signal) => {
          if (timedOut) return finish({ output: { error: `command timed out after ${TIMEOUT_MS / 1000}s (killed with ${signal ?? 'SIGKILL'})` }, isError: true })
          // an external signal (e.g. an OOM SIGKILL) is a real failure, but NOT a timeout — report it as itself
          if (signal) return finish({ output: { error: `command killed by ${signal}` }, isError: true })
          finish({ output: { exitCode: code ?? -1, stdout: clip(stdout), stderr: clip(stderr) }, isError: false })
        })
      })
    },
  }]
}
