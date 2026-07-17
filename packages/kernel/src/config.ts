import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ModelCost } from '@orc/contracts'

// bump per release — pins DBOS__APPVERSION so recovery survives rebuilds (spec §4)
export const APP_VERSION = 'orc-0.1.0'
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:orc@localhost:5433/orc'

const FileConfig = z.object({
  databaseUrl: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  workspaceRoot: z.string().optional(),
  ollamaBaseUrl: z.string().optional(),
  costOverrides: z.record(z.string(), z.record(z.string(), ModelCost)).optional(),
})

export interface OrcConfig {
  databaseUrl: string
  systemDatabaseUrl: string
  concurrency: number
  workspaceRoot: string
  ollamaBaseUrl: string
  appVersion: string
  costOverrides: Record<string, Record<string, z.infer<typeof ModelCost>>>
}

export function deriveSystemUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `${url.pathname}_dbos_sys`
  return url.toString()
}

export function loadConfig(dir: string = process.cwd()): OrcConfig {
  const file = path.join(dir, '.orc', 'config.json')
  const fromFile = existsSync(file) ? FileConfig.parse(JSON.parse(readFileSync(file, 'utf8'))) : {}
  const databaseUrl = process.env.ORC_DATABASE_URL ?? fromFile.databaseUrl ?? DEFAULT_DATABASE_URL
  return {
    databaseUrl,
    systemDatabaseUrl: deriveSystemUrl(databaseUrl),
    concurrency: Number(process.env.ORC_CONCURRENCY ?? fromFile.concurrency ?? 3),
    workspaceRoot: fromFile.workspaceRoot ?? path.join(dir, '.orc', 'workspaces'),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? fromFile.ollamaBaseUrl ?? 'http://localhost:11434',
    appVersion: APP_VERSION,
    costOverrides: fromFile.costOverrides ?? {},
  }
}
