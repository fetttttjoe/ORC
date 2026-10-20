import { realpathSync } from 'node:fs'
import path from 'node:path'
import { AUTHOR_SOURCE, Door, NO_CHAT, type AuthorSource, type Author, type Origin, type Workspace } from '@orc/contracts'
import { workspaceByCwd } from '@orc/kernel'

export interface WorkspaceFold {
  state(): Promise<{ workspaces: ReadonlyMap<string, Workspace> }>
}

// `source`, `workspaceId` and `origin` are left out: cwdAuthor decides the door, workspace and origin
export type AuthorExtras = Omit<Partial<Author>, 'source' | 'workspaceId' | 'origin'>

// realpathSync throws for a missing dir; path.resolve is the kernel's own key normalization
const resolveDir = (dir: string): string => {
  try { return realpathSync(dir) } catch { return path.resolve(dir) }
}

// realpath: the fold matches the cwd exactly and adoption stores the resolved path
export async function cwdWorkspace(kernel: WorkspaceFold, dir: string | undefined): Promise<Workspace> {
  const found = await findCwdWorkspace(kernel, dir)
  if (found === undefined)
    throw new Error('no workspace for this directory — run from a project checkout (orc adopts it on boot) or pass --workspace <id>')
  return found
}

// the same lookup without the refusal, for `orc ws current` where 'nothing yet' is an answer
export async function findCwdWorkspace(kernel: WorkspaceFold, dir: string | undefined): Promise<Workspace | undefined> {
  return dir === undefined ? undefined : workspaceByCwd((await kernel.state()).workspaces, resolveDir(dir))
}

// the id alone; only purgeProject needs the whole record, to re-append it
export const cwdWorkspaceId = async (kernel: WorkspaceFold, dir: string | undefined): Promise<string> =>
  (await cwdWorkspace(kernel, dir)).id

// agent steps do not come through here: their workspace is the one their task names
export async function cwdAuthor(
  kernel: WorkspaceFold, dir: string | undefined, source: AuthorSource, origin: Origin, extra: AuthorExtras = {},
): Promise<Author> {
  // extra FIRST: the three fields this function is responsible for cannot be shadowed by a caller.
  return { ...extra, source, origin, workspaceId: await cwdWorkspaceId(kernel, dir) }
}

export const cliAuthor = (fold: WorkspaceFold, dir: string): Promise<Author> =>
  cwdAuthor(fold, dir, AUTHOR_SOURCE.cli, NO_CHAT(Door.cli))
