import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { jsonSchema, tool } from 'ai'
import { z } from 'zod'
import type { ResolvedTool } from '@orc/contracts'
import { toolError, errorMessage, FS_LIST_TOOL_NAME, FS_READ_TOOL_NAME, FS_WRITE_TOOL_NAME, SignalOutcome, STEP_ROLE, assertInZone, doubleEncodedField, DOUBLE_ENCODED_HINT, resolveInWorkspace, unescapeSequences } from '@orc/contracts'

export const TOOL_NAME = {
  signal: 'signal',
  fs_read: FS_READ_TOOL_NAME,
  fs_write: FS_WRITE_TOOL_NAME.write,
  fs_edit: FS_WRITE_TOOL_NAME.edit,
  fs_delete: FS_WRITE_TOOL_NAME.delete,
  fs_list: FS_LIST_TOOL_NAME,
  join_splits: 'join_splits',
  ask_human: 'ask_human',
} as const

export const SignalInput = z.object({
  outcome: z.enum(SignalOutcome),
  summary: z.string().min(1),
  // workspace-relative files this step produced — verified and receipted by the runtime
  outputs: z.array(z.string().min(1)).optional(),
})
export const JoinSplitsInput = z.object({ splitIds: z.array(z.string()).optional() })
export const AskHumanInput = z.object({ question: z.string().min(1), topic: z.string().min(1).optional() })
// start/end are 1-indexed inclusive line numbers. Both optional: none = whole file; start alone =
// to EOF. Exists so agents read a slice with the tool instead of reaching for `sed -n` via exec.
// start/end are COERCED (z.coerce): agents routinely pass a numeric STRING ("300") for a line number
// — observed live on the codebase-map task, where fs_read('…', start:"300") died on the raw zod
// "expected number, received string" instead of reading. Coercion turns the common case into a read.
const ReadInput = z.object({ path: z.string().min(1), start: z.coerce.number().int().positive().optional(), end: z.coerce.number().int().positive().optional() })
const WriteInput = z.object({ path: z.string().min(1), content: z.string() })
const EditInput = z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() })
const DeleteInput = z.object({ path: z.string().min(1) })
const ListInput = z.object({ path: z.string().default('.') })

// Declared WITHOUT execute — the SDK returns tool calls; execution is ours, inside a durable step.
// Extra (MCP) tools are neutral ResolvedTool[] — their JSON Schema travels as-is via jsonSchema().
export function toolSet(extra: ResolvedTool[] = [], opts: { role?: string; readOnlySource?: boolean } = {}) {
  // Steps that ground a plan — the analyze scout and the plan step — read, run gates, and record
  // knowledge, never source files. A scout once edited tracked code before any plan existed,
  // and the plan step (role=auditor, shared with child verify steps that DO write scratch) tried
  // the same during planning: both bypass the approval gate. The scout is caught by role; the plan
  // step by an explicit readOnlySource flag the kernel sets on it, since role alone can't tell it
  // from a verify step. Registration gate, same reason as exec's: a tool a step must not use is
  // not offered.
  const scout = opts.role === STEP_ROLE.scout || opts.readOnlySource === true
  const set = {
    [TOOL_NAME.signal]: tool({
      description:
        "End this step and report the outcome. Your summary is the ONLY output downstream steps see — put your conclusions in it; the claims you recorded are found with the knowledge tools, so do not restate them. Declare files you produced in `outputs` (workspace-relative paths) so they are verified and receipted. Outcome 'partial' means the work is going well but needs another round: state precisely what is DONE and what REMAINS — the runtime may grant a continuation whose only context is that summary. Never 'partial' for work that is blocked or wrong; that is 'failure'. Call this exactly once per round, when the work is done, needs another round, or cannot proceed.",
      inputSchema: SignalInput,
    }),
    [TOOL_NAME.fs_read]: tool({
      description: 'Read a UTF-8 text file inside the step workspace (path relative to the workspace root). Optional `start`/`end` are 1-indexed inclusive line numbers for a slice — use them to read a range instead of shelling out to sed/head/tail.',
      inputSchema: ReadInput,
    }),
    ...(scout ? {} : {
      [TOOL_NAME.fs_write]: tool({
        description: 'Write a UTF-8 text file inside the step workspace (parent directories are created). Paths are relative to the workspace root. Use fs_edit to change part of an existing file — rewriting a whole file to change a few lines corrupts the rest.',
        inputSchema: WriteInput,
      }),
      [TOOL_NAME.fs_edit]: tool({
        description: 'Replace an exact string in an existing file inside the step workspace (paths relative to the workspace root). `old_string` must appear EXACTLY ONCE — include enough surrounding context to make it unique. Prefer this over fs_write for any change to a file that already exists: it touches only what you name, so the rest of the file cannot be altered by accident.',
        inputSchema: EditInput,
      }),
      [TOOL_NAME.fs_delete]: tool({
        description: 'Delete a file inside the step workspace (path relative to the workspace root). Subject to the same zone write-fence as fs_write/fs_edit. Use for scratch files you created and no longer need — there is no undo.',
        inputSchema: DeleteInput,
      }),
    }),
    [TOOL_NAME.fs_list]: tool({
      description: 'List directory entries inside the step workspace.',
      inputSchema: ListInput,
    }),
    [TOOL_NAME.join_splits]: tool({
      description:
        'Durably wait for child splits proposed with task_split to finish. Returns per-split {outcome, summary, claims} — claims are the ids and knowledge files of the claims the child recorded and did not retire. Omit splitIds to wait for all your pending splits.',
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
  return set
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
  // ONE gate for every tool, before any of them runs: an argument whose escapes were encoded twice
  // corrupts whatever it touches, and it is the ARGUMENT that is wrong, not the tool. Checking it
  // here means every write tool inherits the diagnosis instead of each re-learning it — fs_edit's
  // own check caught only the case where the file proved it.
  const overEncoded = doubleEncodedField(input)
  if (overEncoded)
    return { output: { error: `'${overEncoded}' was rejected: ${DOUBLE_ENCODED_HINT}` }, isError: true }

  // Every write path — whole-file or surgical — passes the same two gates, in the same order, so a
  // new write tool cannot accidentally ship without the fence or the claim registry.
  // Returns an error envelope when the write is refused, or null when it may proceed.
  // Claims the path, or refuses. The claim is taken EAGERLY — before the write is attempted — so the
  // check and the set are atomic against a sibling step racing in the same process; deferring the
  // set until after a successful write would reopen exactly the window the claim exists to close.
  //
  // The cost of that is a claim held by an operation that then refuses (a missing file, an
  // old_string that matches zero or many times) — a path locked against every sibling by a call
  // that wrote nothing. So the handle carries `release`, and it frees the key ONLY if this call is
  // what acquired it: a later refused edit must not release a claim an earlier successful write in
  // the same step legitimately still holds.
  type WriteClaim = { refusal: { output: unknown; isError: boolean } } | { release: () => void }
  const claimWrite = (p: string): WriteClaim => {
    const abs = resolveInWorkspace(workspaceDir, p)
    assertInZone(workspaceDir, abs, guard.zone ?? []) // named fence error → the model can correct course
    if (!guard.writer) return { release: () => {} }
    const key = `${workspaceDir}\u0000${abs}`
    const owner = writeClaims.get(key)
    if (owner !== undefined && owner !== guard.writer)
      return { refusal: { output: { error: `concurrent write refused: '${p}' is being written by a still-running sibling step — write elsewhere or order the steps with dependsOn` }, isError: true } }
    const acquired = owner === undefined
    writeClaims.set(key, guard.writer)
    return { release: () => { if (acquired) writeClaims.delete(key) } }
  }
  // The edit itself, with no claim handling: separating them is what lets the caller release on a
  // refusal without repeating that at each of the three refusal branches.
  const editInPlace = (abs: string, p: string, oldString: string, newString: string): { output: unknown; isError: boolean } => {
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
    if (occurrences === 0) {
      // The tool argument is ALREADY JSON, so a model that escapes its newlines again sends
      // `\\n` — two characters, backslash and n — and the match can never succeed. noteLint
      // warns about the same double-encoding on a memory write; here it is fatal, and "copy the
      // exact text" sends the model back to re-read a file it copied correctly. Name what it
      // actually did instead. Diagnosed, never auto-repaired: a writer mis-encoding its
      // arguments is mis-encoding the file contents too, and silently fixing one hides that.
      const unescaped = unescapeSequences(oldString)
      if (unescaped !== oldString && current.includes(unescaped))
        return { output: { error: `old_string not found in '${p}' because ${DOUBLE_ENCODED_HINT}` }, isError: true }
      return { output: { error: `old_string not found in '${p}' — fs_read it and copy the exact text, whitespace included` }, isError: true }
    }
    if (occurrences > 1)
      return { output: { error: `old_string appears ${occurrences} times in '${p}' — include surrounding lines until it is unique` }, isError: true }
    // replacer function: a bare string replacement interprets $$, $&, $` and $' as patterns,
    // silently corrupting any new_string carrying shell/Makefile text like '$$HOME'
    writeFileAtomic(abs, current.replace(oldString, () => newString))
    return { output: { edited: p }, isError: false }
  }

  // atomic replace: same-directory temp + rename — a reader or a crash never sees a torn file.
  //
  // The rename REPLACES THE INODE, so everything about the target that is not its bytes belongs to
  // the old one and is discarded. Mode is the half that bites: an edit to an executable landed it
  // at 0644 and nothing failed, because the file still worked when invoked as `bun <file>` —
  // measured, packages/cli/src/bin.ts went 100755 to 100644 that way. A git hook is where it stops
  // being cosmetic: git execs the hook file directly, so one that loses the bit silently never runs.
  //
  // So the temp inherits the target's mode before the swap. A NEW file is deliberately left at the
  // default: a write must never GRANT a bit nobody asked for — creating executables is not this
  // tool's job (see scripts/hooks, where the executable dispatcher is committed once and the logic
  // beside it is plain).
  const writeFileAtomic = (abs: string, content: string): void => {
    mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
    try {
      writeFileSync(tmp, content)
      // statSync, not existsSync+stat: one syscall, and ENOENT is the "new file" answer
      let inherited: number | null = null
      try { inherited = statSync(abs).mode & 0o7777 } catch { inherited = null }
      if (inherited !== null) chmodSync(tmp, inherited)
      renameSync(tmp, abs)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* best effort */ }
      throw err
    }
  }

  try {
    switch (name) {
      case TOOL_NAME.fs_read: {
        const { path: p, start, end } = ReadInput.parse(input)
        try {
          const content = readFileSync(resolveInWorkspace(workspaceDir, p), 'utf8')
          if (start === undefined && end === undefined)
            return { output: { content }, isError: false }
          const lines = content.split('\n')
          if (start !== undefined && start > lines.length)
            return { output: { error: `'${p}' has ${lines.length} lines — start ${start} is past end of file` }, isError: true }
          // 1-indexed inclusive → 0-indexed half-open; end defaults to EOF
          return { output: { content: lines.slice((start ?? 1) - 1, end ?? lines.length).join('\n') }, isError: false }
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
        if ('refusal' in claim) return claim.refusal
        try {
          writeFileAtomic(resolveInWorkspace(workspaceDir, p), content)
        } catch (err) {
          // nothing landed on disk, so the path must not stay locked against a sibling
          claim.release()
          throw err
        }
        return { output: { written: p }, isError: false }
      }
      case TOOL_NAME.fs_delete: {
        const { path: p } = DeleteInput.parse(input)
        const abs = resolveInWorkspace(workspaceDir, p)
        assertInZone(workspaceDir, abs, guard.zone ?? []) // deletion is a write — same fence
        // ...and the same CLAIM. fs_delete went through the zone fence but not the claim registry,
        // so a sibling could unlink a file another sibling had claimed and was still writing: no
        // refusal, no record, the file simply gone. FS_WRITE_TOOL_NAME lists delete as a write and
        // loop.ts tracks it as one for claims-at-risk — only this branch disagreed.
        const claim = claimWrite(p)
        if ('refusal' in claim) return claim.refusal
        try {
          unlinkSync(abs)
        } catch (err) {
          // nothing was removed, so the path must not stay locked against a sibling
          claim.release()
          // a missing file / a directory / EACCES — a result to read, not a crash (mirrors fs_write)
          return { output: { error: `could not delete '${p}': ${errorMessage(err)}` }, isError: true }
        }
        return { output: { deleted: p }, isError: false }
      }
      case TOOL_NAME.fs_edit: {
        const { path: p, old_string: oldString, new_string: newString } = EditInput.parse(input)
        const claim = claimWrite(p)
        if ('refusal' in claim) return claim.refusal
        let out: { output: unknown; isError: boolean }
        try {
          out = editInPlace(resolveInWorkspace(workspaceDir, p), p, oldString, newString)
        } catch (err) {
          // the write itself threw (ENOSPC, EACCES) — same as fs_write: nothing landed on disk,
          // so the path must not stay locked against a sibling
          claim.release()
          throw err
        }
        // Every refusal branch (missing file, old_string matched zero or many times) wrote no
        // byte, so holding the path would fence out every sibling step over an edit that never
        // happened. A SUCCESSFUL edit keeps the claim — the step owns what it wrote until its
        // turn ends.
        if (out.isError) claim.release()
        return out
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
    return toolError(err)
  }
}
