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
  fs_edit: 'fs_edit',
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
const EditInput = z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() })
const ListInput = z.object({ path: z.string().default('.') })

// Declared WITHOUT execute — the SDK returns tool calls; execution is ours, inside a durable step (spec §6.2).
// Extra (MCP) tools are neutral ResolvedTool[] (spec seam D1) — their JSON Schema travels as-is via jsonSchema().
export function toolSet(extra: ResolvedTool[] = []) {
  return {
    [TOOL_NAME.signal]: tool({
      description:
        'End this step and report the outcome. Your summary is the ONLY output downstream steps see — put your conclusions and the ids of notes you wrote in it; do not restate note bodies (downstream pulls notes at its own budget). Declare files you produced in `outputs` (workspace-relative paths) so they are verified and receipted. Call this exactly once, when the work is done or cannot proceed.',
      inputSchema: SignalInput,
    }),
    [TOOL_NAME.fs_read]: tool({
      description: 'Read a UTF-8 text file inside the step workspace.',
      inputSchema: ReadInput,
    }),
    [TOOL_NAME.fs_write]: tool({
      description: 'Write a UTF-8 text file inside the step workspace (parent directories are created). Use fs_edit to change part of an existing file — rewriting a whole file to change a few lines corrupts the rest.',
      inputSchema: WriteInput,
    }),
    [TOOL_NAME.fs_edit]: tool({
      description: 'Replace an exact string in an existing file inside the step workspace. `old_string` must appear EXACTLY ONCE — include enough surrounding context to make it unique. Prefer this over fs_write for any change to a file that already exists: it touches only what you name, so the rest of the file cannot be altered by accident.',
      inputSchema: EditInput,
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
  // Every write path — whole-file or surgical — passes the same two gates, in the same order, so a
  // new write tool cannot accidentally ship without the fence or the claim registry.
  // Returns an error envelope when the write is refused, or null when it may proceed.
  const claimWrite = (p: string): { output: unknown; isError: boolean } | null => {
    const abs = resolveInWorkspace(workspaceDir, p)
    assertInZone(workspaceDir, abs, guard.zone ?? []) // named fence error → the model can correct course
    if (!guard.writer) return null
    const key = `${workspaceDir}\u0000${abs}`
    const owner = writeClaims.get(key)
    if (owner !== undefined && owner !== guard.writer)
      return { output: { error: `concurrent write refused: '${p}' is being written by a still-running sibling step — write elsewhere or order the steps with dependsOn` }, isError: true }
    writeClaims.set(key, guard.writer)
    return null
  }
  // atomic replace: same-directory temp + rename — a reader or a crash never sees a torn file
  const writeFileAtomic = (abs: string, content: string): void => {
    mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
    try {
      writeFileSync(tmp, content)
      renameSync(tmp, abs)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* best effort */ }
      throw err
    }
  }

  try {
    switch (name) {
      case TOOL_NAME.fs_read: {
        const { path: p } = ReadInput.parse(input)
        try {
          return { output: { content: readFileSync(resolveInWorkspace(workspaceDir, p), 'utf8') }, isError: false }
        } catch (err) {
          // a raw EISDIR errno reads like a crash — name the correction instead
          if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EISDIR')
            return { output: { error: `'${p}' is a directory — use fs_list to see its entries` }, isError: true }
          throw err
        }
      }
      case TOOL_NAME.fs_write: {
        const { path: p, content } = WriteInput.parse(input)
        const claim = claimWrite(p)
        if (claim) return claim
        writeFileAtomic(resolveInWorkspace(workspaceDir, p), content)
        return { output: { written: p }, isError: false }
      }
      case TOOL_NAME.fs_edit: {
        const { path: p, old_string: oldString, new_string: newString } = EditInput.parse(input)
        const claim = claimWrite(p)
        if (claim) return claim
        const abs = resolveInWorkspace(workspaceDir, p)
        let current: string
        try {
          current = readFileSync(abs, 'utf8')
        } catch {
          return { output: { error: `'${p}' does not exist — use fs_write to create it` }, isError: true }
        }
        // exactly once, or refuse: zero means the model is editing something it did not read, and
        // more than one means it cannot know which site it changed. Both are silent corruption if
        // guessed at, and both are cheap for the model to fix by widening the context it names.
        const occurrences = current.split(oldString).length - 1
        if (occurrences === 0)
          return { output: { error: `old_string not found in '${p}' — fs_read it and copy the exact text, whitespace included` }, isError: true }
        if (occurrences > 1)
          return { output: { error: `old_string appears ${occurrences} times in '${p}' — include surrounding lines until it is unique` }, isError: true }
        writeFileAtomic(abs, current.replace(oldString, newString))
        return { output: { edited: p }, isError: false }
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
