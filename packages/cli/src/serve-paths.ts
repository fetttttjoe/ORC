import path from 'node:path'
import type { ProjectConfig } from '@orc/kernel'

// Under .orc/ of the PROJECT, not of the checkout: one supervisor, one trust file, one log per
// repository. A worktree that wrote its own .orc/serve.pid would let two supervisors believe they
// were alone on one project.
// Own module, not main.ts: supervisor-client.ts's "no supervisor came up" error needs the real log
// path too, and main.ts already imports supervisor-client.ts, so importing back would cycle them.
export function serveLogFile(config: Pick<ProjectConfig, 'projectRoot'>): string {
  return path.join(config.projectRoot, '.orc', 'serve.log')
}

export function servePidFile(projectRoot: string): string {
  return path.join(projectRoot, '.orc', 'serve.pid')
}
