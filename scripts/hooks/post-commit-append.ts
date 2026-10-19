// The DETACHED half of scripts/hooks/post-commit (see that file's header for the detach
// mechanism and why: git's post-commit hook runs synchronously, so the bun-startup + Postgres
// round-trip this file does can never sit on a `git commit`'s critical path — the sh hook spawns
// this with `nohup … &` and does not wait for it).
//
// Silent degrade: ANY failure here — no `.orc` project (requireProject throws), the database
// unreachable, a malformed sha — is swallowed with nothing printed, mirroring
// packages/cli/src/actions.ts's buildModelDiscovery taskless append (`.catch(() => {})`). A
// hand-made commit that could not be recorded is still a commit; this is a courtesy to the log,
// never a gate.
//
// Relative imports: scripts/ is not a workspace package, so `@orc/*` specifiers do not resolve here.
import { z } from 'zod'
import { Kernel, loadConfig, openStorage, requireProject } from '../../packages/kernel/src/index'
import type { EventLog } from '../../packages/kernel/src/index'
import { Door, EVENT_KIND, ORC_CHAT_ID, type Origin } from '../../packages/contracts/src/index'
import { findCwdWorkspace } from '../../packages/cli/src/cwd-workspace'
import { parseChangedPaths } from './post-commit-paths'

// Read through the constant the commit tool writes with: a second spelling here would silently
// stop matching if that name changed. Empty or absent is no chat, never the string 'undefined'.
const ChatId = z.string().min(1)
export const hookOrigin = (env: Record<string, string | undefined>): Origin => {
  const parsed = ChatId.safeParse(env[ORC_CHAT_ID])
  return { chatId: parsed.success ? parsed.data : null, door: Door.hook }
}

export async function appendCommit(
  events: EventLog, sha: string, rawPaths: string, env: Record<string, string | undefined>, dir: string,
): Promise<void> {
  // The commit belongs to the checkout it was made in; a commit whose workspace is unknown is
  // still worth recording, so a miss is null rather than the refusal cwdWorkspace would raise.
  const workspace = await findCwdWorkspace(new Kernel(events), dir)
  // idempotencyKey = sha: a retried/duplicated hook invocation for the same commit (e.g. the
  // sh wrapper's detached spawn racing a second one) cannot double-append — same conflict
  // resolution as every other deterministic writer (event-log.ts's onConflictDoNothing).
  await events.append({
    ...hookOrigin(env),
    taskId: null, stepId: null, runToken: null,
    kind: EVENT_KIND.commit_recorded,
    payload: { sha, paths: parseChangedPaths(rawPaths), workspaceId: workspace?.id ?? null },
    idempotencyKey: sha,
  })
}

async function main(): Promise<void> {
  const sha = process.argv[2]
  if (!sha) return

  const config = requireProject(loadConfig())
  const storage = await openStorage(config.databaseUrl, { projectId: config.projectId, redactEnv: config.redactEnv })
  try {
    await appendCommit(storage.events, sha, process.argv[3] ?? '', process.env, process.cwd())
  } finally {
    await storage.close()
  }
}

main().catch(() => {})
