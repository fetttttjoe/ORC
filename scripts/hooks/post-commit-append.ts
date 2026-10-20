// Relative imports: scripts/ is not a workspace package, so `@orc/*` does not resolve here
import { z } from 'zod'
import { Kernel, loadConfig, openStorage, requireProject } from '../../packages/kernel/src/index'
import type { EventLog } from '../../packages/kernel/src/index'
import { Door, EVENT_KIND, ORC_CHAT_ID, type Origin } from '../../packages/contracts/src/index'
import { findCwdWorkspace } from '../../packages/cli/src/cwd-workspace'
import { parseChangedPaths } from './post-commit-paths'

// the constant the commit tool writes with; empty or absent is no chat, never 'undefined'
const ChatId = z.string().min(1)
export const hookOrigin = (env: Record<string, string | undefined>): Origin => {
  const parsed = ChatId.safeParse(env[ORC_CHAT_ID])
  return { chatId: parsed.success ? parsed.data : null, door: Door.hook }
}

export async function appendCommit(
  events: EventLog, sha: string, rawPaths: string, env: Record<string, string | undefined>, dir: string,
): Promise<void> {
  // an unknown workspace is still worth recording, so a miss is null rather than a refusal
  const workspace = await findCwdWorkspace(new Kernel(events), dir)
  // idempotencyKey = sha: a duplicated hook invocation cannot double-append
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

// silent degrade: a commit that cannot be recorded is still a commit, never a gate
main().catch(() => {})
