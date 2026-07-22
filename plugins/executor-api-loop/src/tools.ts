import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { jsonSchema, tool } from 'ai'
import { z } from 'zod'
import type { ResolvedTool } from '@orc/contracts'
import { errorMessage, SignalOutcome, assertInZone, resolveInWorkspace } from '@orc/contracts'

export const TOOL_NAME = {
  signal: 'signal',
  fs_read: 'fs_read',
  fs_write: 'fs_write',
  fs_list: 'fs_list',
  join_splits: 'join_splits',
  ask_human: 'ask_human',
} as const
export type ToolName = (typeof TOOL_NAME)[keyof typeof TOOL_NAME]

export const SignalInput = z.object({
  outcome: SignalOutcome,
  summary: z.string().min(1),
  // workspace-relative files this step produced — verified and receipted by the runtime
  outputs: z.array(z.string().min(1)).optional(),
})
export const JoinSplitsInput = z.object({ splitIds: z.array(z.string()).optional() })
export const AskHumanInput = z.object({ question: z.string().min(1), topic: z.string().min(1).optional() })
const ReadInput = z.object({ path: z.string().min(1) })
const WriteInput = z.object({ path: z.string().min(1), content: z.string() })
const ListInput = z.object({ path: z.string().default('.') })

// Declared WITHOUT execute — the SDK returns tool calls; execution is ours, inside a durable step (spec §6.2).
// Extra (MCP) tools are neutral ResolvedTool[] (spec seam D1) — their JSON Schema travels as-is via jsonSchema().
export function toolSet(extra: ResolvedTool[] = []) {
  return {
    [TOOL_NAME.signal]: tool({
      description:
        'End this step and report the outcome. Your summary is the ONLY output downstream steps see — put your results/conclusions in it. Declare files you produced in `outputs` (workspace-relative paths) so they are verified and receipted. Call this exactly once, when the work is done or cannot proceed.',
      inputSchema: SignalInput,
    }),
    [TOOL_NAME.fs_read]: tool({
      description: 'Read a UTF-8 text file inside the step workspace.',
      inputSchema: ReadInput,
    }),
    [TOOL_NAME.fs_write]: tool({
      description: 'Write a UTF-8 text file inside the step workspace (parent directories are created).',
      inputSchema: WriteInput,
    }),
    [TOOL_NAME.fs_list]: tool({
      description: 'List directory entries inside the step workspace.',
      inputSchema: ListInput,
    }),
    [TOOL_NAME.join_splits]: tool({
      description:
        'Durably wait for child splits proposed with task_split to finish. Returns per-split {outcome, summary, notes} — notes are memory ids to read with memory_read or traverse with memory_neighbors. Omit splitIds to wait for all your pending splits.',
      inputSchema: JoinSplitsInput,
    }),
    [TOOL_NAME.ask_human]: tool({
      description:
        'Durably ask the human a question and wait for their reply. The run suspends until a human answers, then returns {answer}. Use for approval/clarification (e.g. plan authoring); do NOT poll — one question per call.',
      inputSchema: AskHumanInput,
    }),
    ...Object.fromEntries(extra.map(t => [
      t.name,
      tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]) }),
    ])),
  }
}

// In-process write-claim registry — the enforcement the plan-authoring skill can only ask
// for: the FIRST still-running step to write a path owns it; a concurrent sibling writing
// the same path is refused with a named error instead of silently last-write-winning.
// Claims release when the step's turn ends (loop.ts finally); a retry attempt is a new
// writer. Crash-safe by construction: a dead process takes its map with it.
// ponytail: in-process Map matches the single-process DBOS runtime; move claims to pg
// advisory locks if step execution ever spans processes.
const writeClaims = new Map<string, string>() // `${workspaceDir}\u0000${abs}` → writer (runToken)
export function releaseWriteClaims(writer: string): void {
  for (const [k, v] of writeClaims) if (v === writer) writeClaims.delete(k)
}

export interface WriteGuard {
  zone?: string[] // declared write-fence globs; [] / absent = unfenced
  writer?: string // claim owner (the step's runToken); absent = no concurrency guard (tests, single-step)
}

export async function executeTool(
  name: string,
  input: unknown,
  workspaceDir: string,
  extra: ResolvedTool[] = [],
  toolCallId?: string,
  guard: WriteGuard = {},
): Promise<{ output: unknown; isError: boolean }> {
  try {
    switch (name) {
      case TOOL_NAME.fs_read: {
        const { path: p } = ReadInput.parse(input)
        return { output: { content: readFileSync(resolveInWorkspace(workspaceDir, p), 'utf8') }, isError: false }
      }
      case TOOL_NAME.fs_write: {
        const { path: p, content } = WriteInput.parse(input)
        const abs = resolveInWorkspace(workspaceDir, p)
        assertInZone(workspaceDir, abs, guard.zone ?? []) // named fence error → the model can correct course
        if (guard.writer) {
          const key = `${workspaceDir}\u0000${abs}`
          const owner = writeClaims.get(key)
          if (owner !== undefined && owner !== guard.writer)
            return { output: { error: `concurrent write refused: '${p}' is being written by a still-running sibling step — write elsewhere or order the steps with dependsOn` }, isError: true }
          writeClaims.set(key, guard.writer)
        }
        mkdirSync(path.dirname(abs), { recursive: true })
        // atomic replace: same-directory temp + rename — a reader or a crash never sees a torn file
        const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
        try {
          writeFileSync(tmp, content)
          renameSync(tmp, abs)
        } catch (err) {
          try { unlinkSync(tmp) } catch { /* best effort */ }
          throw err
        }
        return { output: { written: p }, isError: false }
      }
      case TOOL_NAME.fs_list: {
        const { path: p } = ListInput.parse(input)
        return { output: { entries: readdirSync(resolveInWorkspace(workspaceDir, p)).sort() }, isError: false }
      }
      default: {
        const ext = extra.find(t => t.name === name)
        if (!ext) return { output: { error: `unknown tool '${name}'` }, isError: true }
        return await ext.execute(input, toolCallId)
      }
    }
  } catch (err) {
    return { output: { error: errorMessage(err) }, isError: true }
  }
}
