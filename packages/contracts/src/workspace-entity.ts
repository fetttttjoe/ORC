import { z } from 'zod'

// A workspace is ONE checkout being worked in — the Paseo shape. Two kinds only: `checkout` (work
// directly in a git checkout on whatever branch it has) and `worktree` (orc ran `git worktree add`
// for one request). `managed` is the fact that gates `git worktree remove`: orc may delete only
// what it created. `cwd` is the natural key — adoption matches on the realpath, so a moved
// worktree is a new workspace and the old record is archived by the operator, never re-pointed.
// Named `workspace-entity` because `workspace.ts` already holds the step write fence
// (resolveInWorkspace); the two share the word on purpose — a workspace IS the directory a step runs in.
export const WORKSPACE_KINDS = ['checkout', 'worktree'] as const
export const WorkspaceKind = z.enum(WORKSPACE_KINDS)
export type WorkspaceKind = z.infer<typeof WorkspaceKind>
export const WORKSPACE_KIND = WorkspaceKind.enum

export const WORKSPACE_TITLE_MAX = 120

export const Workspace = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(WORKSPACE_TITLE_MAX),
  cwd: z.string().min(1),
  branch: z.string().min(1).nullable(),
  baseBranch: z.string().min(1).nullable(),
  kind: WorkspaceKind,
  managed: z.boolean(),
  // Captured at creation/adoption: branch === the project's trunk. Notes written on trunk are final
  // by construction; everywhere else they are provisional until workspace_merged.
  onTrunk: z.boolean(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(), // required key: nothing about a workspace record defaults silently
})
export type Workspace = z.infer<typeof Workspace>

// ── Health ────────────────────────────────────────────────────────────────────────────────────
// The whole state vocabulary, spelled once — a literal 'dangling' at a render site is what drifts
// from the rule that produces it. Same pattern as `WorkspaceKind` above and `TASK_STATUS`: the tuple
// is the single source, z.enum gives the runtime parser, and `.enum` gives the named constants.
//
// It lives in CONTRACTS rather than beside the derivation that produces it (the kernel's
// workspaceHealth) because the vocabulary is not the policy: the browser bundle cannot import the
// kernel — it has no database driver — and parses a workspace's health off the wire with the schema
// below. A second spelling there is exactly how a state added here stops being rendered anywhere.
export const WORKSPACE_STATES = ['active', 'waiting', 'idle', 'merged', 'dangling'] as const
export const WorkspaceState = z.enum(WORKSPACE_STATES)
export type WorkspaceState = z.infer<typeof WorkspaceState>
export const WORKSPACE_STATE = WorkspaceState.enum

// ONE verdict per workspace, derived from the fold plus what only a caller can probe (the
// filesystem, the note read model). The DERIVATION stays in the kernel; this is the shape it
// produces and the schema every other surface reads it back with.
export const WorkspaceHealth = z.object({
  state: WorkspaceState,
  // The newest stamp this workspace has, over its tasks' events AND its own record's events. NO
  // THRESHOLD ANYWHERE: the age is printed and the human decides. A cutoff here would be a tuned
  // constant with no measurement behind it, quietly restating itself as policy.
  // null only when the log shows nothing at all for this workspace — never a fabricated stamp.
  lastActivityAt: z.string().nullable(),
  taskCount: z.number().int(),
  openTaskCount: z.number().int(),
  // Whether `workspace_merged` was recorded, independent of the STATE — which the rungs above
  // `merged` can shadow (a landed workspace with a running task reads `active`). Without the flag a
  // reader cannot tell that case from one that never landed, and "has this work landed?" is the
  // question the whole workspace transaction exists to answer.
  merged: z.boolean(),
  // null = the note read model could not be asked (Surreal down), rendered '?'. Distinct from 0,
  // which is a measured "nothing pending" — the same absent/zero discipline measureDrift keeps.
  provisionalNotes: z.number().int().nullable(),
  dirExists: z.boolean(),
  // three-valued for the reason isClean is: null means git declined to answer (the directory is not
  // a checkout, or is gone), which is a different fact from "has uncommitted work".
  clean: z.boolean().nullable(),
})
export type WorkspaceHealth = z.infer<typeof WorkspaceHealth>

// What every door hands back for one workspace: the record and the verdict, together. Named here
// rather than spelled inline at each door so `OrcActions.listWorkspaces`, the copilot's
// project_status dep and the CLI lister cannot disagree about the field names.
export const WorkspaceWithHealth = z.object({ workspace: Workspace, health: WorkspaceHealth })
export type WorkspaceWithHealth = z.infer<typeof WorkspaceWithHealth>

// The "commit" of the workspace transaction. Appended by `orc ws merge`, `orc ws finalize`, or the
// commit reactor once it can see the branch tip is an ancestor of trunk. Nothing else changes a
// note's finality — it is derived from this event's absence or presence.
export const WorkspaceMergedPayload = z.object({ workspaceId: z.string().min(1), mergeCommit: z.string().min(1), trunk: z.string().min(1), at: z.string() })
export type WorkspaceMergedPayload = z.infer<typeof WorkspaceMergedPayload>

// The zod twin of what plugins/memory's import-free `provisionalOf` returns — carried, ABSENT when
// final, on every row the memory read surfaces hand out. It names the workspace so a reader can act
// on the flag (go and merge that checkout) rather than only distrust the note; `title` is what a
// human recognises the checkout by, where the id alone is a uuid.
//
// Lives here, on the workspace entity, because that is what the flag is ABOUT and because both
// claim.ts and memory.ts carry it — claim.ts cannot import memory.ts (memory.ts imports it), so a
// shape owned by either would be unreachable from the other.
export const ProvisionalFlag = z.object({ workspaceId: z.string().min(1), title: z.string() })
export type ProvisionalFlag = z.infer<typeof ProvisionalFlag>

export const WorkspaceCreatedPayload = z.object({ workspace: Workspace })
export type WorkspaceCreatedPayload = z.infer<typeof WorkspaceCreatedPayload>
export const WorkspaceRetitledPayload = z.object({ workspaceId: z.string().min(1), title: z.string().min(1).max(WORKSPACE_TITLE_MAX) })
export type WorkspaceRetitledPayload = z.infer<typeof WorkspaceRetitledPayload>
// `archived` is a parameter, not two event kinds — the same rule `orc memory archive/restore`
// follows (one store call with a flag), so restore cannot drift from archive.
export const WorkspaceArchivedPayload = z.object({ workspaceId: z.string().min(1), archived: z.boolean(), at: z.string() })
export type WorkspaceArchivedPayload = z.infer<typeof WorkspaceArchivedPayload>
