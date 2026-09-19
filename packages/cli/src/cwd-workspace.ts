import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { AuthorSource, MemoryAuthor, Origin, Workspace } from '@orc/contracts'
import { workspaceByCwd } from '@orc/kernel'

// The ONE thing either door reads off the kernel: the folded workspace table. Named and narrow so
// the doors cannot drift into depending on the rest of the fold, and so a caller (a test, a future
// read-model-backed source) can answer it with one map instead of a whole State. A real Kernel
// satisfies it structurally.
export interface WorkspaceFold {
  state(): Promise<{ workspaces: ReadonlyMap<string, Workspace> }>
}

// What a caller may add to an author on top of the two fields this module derives. `source` and
// `workspaceId` are deliberately NOT in it: the door and the workspace are what cwdAuthor exists to
// decide, and a caller able to pass its own workspaceId here would reintroduce exactly the guessed
// workspace MemoryAuthor.workspaceId's required key exists to prevent.
export type AuthorExtras = Omit<Partial<MemoryAuthor>, 'source' | 'workspaceId' | 'origin'>

// realpathSync THROWS (ENOENT) for a directory that is not there — a project dir that has been
// deleted, or a config naming a path nobody created. That is still "no workspace here", and the
// refusal below says something the operator can act on where an ENOENT stack does not. path.resolve
// is the same syntactic normalization the kernel's workspace key applies, so the fallback asks the
// fold the same question the real path would have.
const resolveDir = (dir: string): string => {
  try { return realpathSync(dir) } catch { return path.resolve(dir) }
}

// "Which workspace does a task created HERE belong to?" — the checkout the command is running in.
// ONE implementation: the `new` command, the actions layer (web + MCP doors) and the auto-heal
// reactor all answer it, and three spellings of the same lookup would drift on the realpath or on
// what a miss means.
//
// realpath, because the fold matches the cwd string EXACTLY and boot adoption stores the resolved
// path — asking with a symlinked spelling would miss the record adoption just wrote and mint a
// duplicate workspace for one directory.
//
// A miss THROWS rather than returning undefined: boot adoption (workspace-adopt) records this
// checkout before any command handler runs, so a miss means there is no project context at all,
// and a null would only resurface as the kernel's less actionable refusal one call later.
export async function cwdWorkspace(kernel: WorkspaceFold, dir: string | undefined): Promise<Workspace> {
  const found = await findCwdWorkspace(kernel, dir)
  if (found === undefined)
    throw new Error('no workspace for this directory — run from a project checkout (orc adopts it on boot) or pass --workspace <id>')
  return found
}

// The same lookup WITHOUT the refusal, for the one caller whose whole job is to report the answer:
// `orc ws current` asks "what is this directory", and "nothing yet" is an answer rather than a
// wiring bug — the refusal above names `--workspace <id>`, a flag that command does not have.
// Split out rather than duplicated at the call site so both doors share one realpath policy (the
// ENOENT fallback included) and one reading of what an exact-cwd match means; a second
// `workspaceByCwd(..., realpathSync(dir))` in a command file is how the two drift.
export async function findCwdWorkspace(kernel: WorkspaceFold, dir: string | undefined): Promise<Workspace | undefined> {
  return dir === undefined ? undefined : workspaceByCwd((await kernel.state()).workspaces, resolveDir(dir))
}

// The id alone, which is what nearly every caller wants. The whole RECORD is only needed where it
// has to survive the log being rewritten — see purgeProject, which re-appends it.
export const cwdWorkspaceId = async (kernel: WorkspaceFold, dir: string | undefined): Promise<string> =>
  (await cwdWorkspace(kernel, dir)).id

// The ONE builder for every author that is NOT an agent step's: the CLI commands, the MCP door, the
// auto-heal reactor and post-task consolidation. They all answer "which workspace am I writing
// from?" the same way — the checkout the process is running in — and a per-door spelling would
// drift on the realpath, on what a miss means, or (worse) on quietly substituting a default.
//
// An agent step does NOT come through here: its workspace is the one its TASK names, which may be a
// different worktree from the one the supervisor process was started in. See the port's stepTools.
//
// The throw is inherited from cwdWorkspaceId and is the point: a writer that cannot name its
// workspace is a wiring bug, and a placeholder would file the note under the wrong checkout
// forever — MemoryAuthor.workspaceId is captured at write time and never recoverable later.
export async function cwdAuthor(
  kernel: WorkspaceFold, dir: string | undefined, source: AuthorSource, origin: Origin, extra: AuthorExtras = {},
): Promise<MemoryAuthor> {
  // extra FIRST: the three fields this function is responsible for cannot be shadowed by a caller.
  return { ...extra, source, origin, workspaceId: await cwdWorkspaceId(kernel, dir) }
}
