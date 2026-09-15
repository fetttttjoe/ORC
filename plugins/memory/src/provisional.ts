/**
 * Is a note still pending in a checkout that has not landed on trunk?
 *
 * Knowledge written from a worktree describes code nobody else can see yet. A reader handed such a
 * note as though it were project knowledge acts on a design that may never merge — and the note
 * itself cannot say so, because finality is not a property of the note at all: it is a property of
 * the WORKSPACE it was written from, and it changes without the note being touched.
 *
 * So this is a DERIVATION, never a stored tag. Nothing writes `provisional` anywhere: the flag is
 * computed at read time from the note's workspace and the workspace table's current standing, which
 * is what makes `workspace_merged` clear it across the whole corpus at once. A stored flag would
 * need a sweep over every note the merge freed, and any note the sweep missed would keep warning
 * about a checkout that no longer exists.
 *
 * Pure and IMPORT-FREE, the shape cluster.ts is the model for: no database, no clock, no config, no
 * contracts. That is what makes it testable against a hand-built map and the designated place to
 * extend the rule. The consequence is that the two-field result is spelled structurally here and as
 * a zod twin in contracts (`ProvisionalFlag`) — the same split contracts' `Topic` has against
 * cluster.ts's pure partition, and the compiler checks the two agree at every call site.
 */

// What the derivation needs to know about one workspace, and nothing more: whether its checkout IS
// trunk, and what to call it in a flag a human reads. A narrow shape rather than the kernel's
// `Workspace` so this file stays import-free and a caller can answer it from anything.
export interface WorkspaceStanding { onTrunk: boolean; title: string }

// The whole input a read surface needs to flag its rows: the workspace table plus the ids that have
// merged. `merged` is a SET of ids, not the merge records — the derivation asks only whether the
// workspace transaction committed, never what it committed to.
export interface WorkspaceView {
  workspaces: ReadonlyMap<string, WorkspaceStanding>
  merged: ReadonlySet<string>
}

// Re-read per call by every consumer, the same way the drift probe is: a merge recorded mid-session
// must clear the flag on the next read without anything being rebuilt.
export type WorkspaceViewProbe = () => Promise<WorkspaceView>

export function provisionalOf(
  note: { workspaceId: string },
  workspaces: ReadonlyMap<string, WorkspaceStanding>,
  merged: ReadonlySet<string>,
): { workspaceId: string; title: string } | null {
  const ws = workspaces.get(note.workspaceId)
  // NEVER INVENT A FLAG. A workspace the table does not know — an id whose `workspace_created` fell
  // outside the events the view was folded from, e.g. a note that outlived a log purge — is not
  // evidence the note is pending: it is evidence we cannot tell. Flagging it would send a reader to
  // merge a checkout nothing can find, and the flag names the workspace precisely so it can be acted
  // on. NOT the archived case: `workspace_archived` keeps the record in the fold, so an archived
  // workspace that never merged is still known here and still flags — correctly, since its notes
  // really are not on trunk.
  if (ws === undefined) return null
  // Written from the trunk checkout: final by construction, with no merge to wait for.
  if (ws.onTrunk) return null
  // The workspace transaction committed — everything it wrote is trunk knowledge now, whether or not
  // any individual note was touched by the merge.
  if (merged.has(note.workspaceId)) return null
  return { workspaceId: note.workspaceId, title: ws.title }
}
