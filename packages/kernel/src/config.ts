import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { MCP_SERVER_ID_RE, McpServerConfig, ModelCost } from '@orc/contracts'

// bump per release — pins DBOS__APPVERSION so recovery survives rebuilds (spec §4)
export const APP_VERSION = 'orc-0.1.0'
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:orc@localhost:5433/orc'

// ONE zod schema resolves all settings — defaults live in .default(), never in ?? chains.
// Input is file config merged with env overrides (env wins); everything orc's own code
// consumes is validated here, loudly. (Env of third-party processes we spawn — MCP
// servers/containers — stays a loose optional record by design: theirs can be absent
// or opaque.) The schema is a factory because path defaults depend on the project dir.
const settingsSchema = (dir: string) =>
  z.object({
    databaseUrl: z.url().default(DEFAULT_DATABASE_URL),
    concurrency: z.coerce.number().int().positive().default(3),
    workspaceRoot: z.string().default(path.join(dir, '.orc', 'workspaces')),
    ollamaBaseUrl: z.url().default('http://localhost:11434'),
    costOverrides: z.record(z.string(), z.record(z.string(), ModelCost)).default({}),
    skillsDir: z.string().default(path.join('vault', 'skills')).transform(p => path.resolve(dir, p)),
    extensions: z.array(z.string()).default([]),
    mcpServers: z.record(z.string().regex(MCP_SERVER_ID_RE), McpServerConfig).default({}),
  })

// container reality: `VAR=` (empty) counts as unset, not as a value
const envOverrides = (): Record<string, string> => {
  const map = {
    databaseUrl: process.env.ORC_DATABASE_URL,
    concurrency: process.env.ORC_CONCURRENCY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  }
  return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => Boolean(e[1])))
}

// derived from the schema so a new setting can never drift out of the type
export type OrcConfig = z.infer<ReturnType<typeof settingsSchema>> & {
  dir: string
  systemDatabaseUrl: string
  appVersion: string
}

export function deriveSystemUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `${url.pathname}_dbos_sys`
  return url.toString()
}

export function loadConfig(dir: string = process.cwd()): OrcConfig {
  const file = path.join(dir, '.orc', 'config.json')
  let fromFile: unknown = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`invalid orc config: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const parsed = settingsSchema(dir).safeParse({ ...(fromFile as Record<string, unknown>), ...envOverrides() })
  if (!parsed.success)
    throw new Error(
      `invalid orc config (env / .orc/config.json): ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  return {
    ...parsed.data,
    dir,
    systemDatabaseUrl: deriveSystemUrl(parsed.data.databaseUrl),
    appVersion: APP_VERSION,
  }
}
