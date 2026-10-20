import path from 'node:path'
import type { ProjectConfig } from '@orc/kernel'

// under the PROJECT's .orc/, not the checkout's: one supervisor, one trust file, one log
export function serveLogFile(config: Pick<ProjectConfig, 'projectRoot'>): string {
  return path.join(config.projectRoot, '.orc', 'serve.log')
}

export function servePidFile(projectRoot: string): string {
  return path.join(projectRoot, '.orc', 'serve.pid')
}
