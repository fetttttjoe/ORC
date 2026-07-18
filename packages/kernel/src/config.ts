import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ApprovalPolicy, MCP_SERVER_ID_RE, McpServerConfig, ModelCost } from '@orc/contracts'

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
    projectId: z.uuid().nullable().default(null),
    projectName: z.string().min(1).nullable().default(null),
    redactEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
    databaseUrl: z.url().default(DEFAULT_DATABASE_URL),
    concurrency: z.coerce.number().int().positive().default(3),
    maxDepth: z.coerce.number().int().positive().default(3),
    approvalPolicy: ApprovalPolicy.prefault({}), // {} isn't the full output shape — prefault reparses it, applying ApprovalPolicy's own field defaults
    workspaceRoot: z.string().default(path.join(dir, '.orc', 'workspaces')),
    ollamaBaseUrl: z.url().default('http://localhost:11434'),
    projectDbUrl: z.string().default('ws://127.0.0.1:8000/rpc'),
    projectDbName: z.string().default('memory'),
    projectDbNamespace: z.string().default('orc'),
    projectDbUser: z.string().default('root'),
    projectDbPassword: z.string().default('orc'),
    costOverrides: z.record(z.string(), z.record(z.string(), ModelCost)).default({}),
    vaultDir: z.string().default(path.join(dir, 'vault')).transform(p => path.resolve(dir, p)),
    skillsDir: z.string().optional().transform(p => (p === undefined ? undefined : path.resolve(dir, p))),
    extensions: z.array(z.string()).default([]),
    mcpServers: z.record(z.string().regex(MCP_SERVER_ID_RE), McpServerConfig).default({}),
  })

// container reality: `VAR=` (empty) counts as unset, not as a value
const envOverrides = (): Record<string, string> => {
  const map = {
    databaseUrl: process.env.ORC_DATABASE_URL,
    concurrency: process.env.ORC_CONCURRENCY,
    maxDepth: process.env.ORC_MAX_DEPTH,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    projectDbUrl: process.env.ORC_PROJECT_DB_URL,
    projectDbName: process.env.ORC_PROJECT_DB_NAME,
    projectDbNamespace: process.env.ORC_PROJECT_DB_NAMESPACE,
    projectDbUser: process.env.ORC_PROJECT_DB_USER,
    projectDbPassword: process.env.ORC_PROJECT_DB_PASSWORD,
  }
  return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => Boolean(e[1])))
}

// derived from the schema so a new setting can never drift out of the type
export type OrcConfig = Omit<z.infer<ReturnType<typeof settingsSchema>>, 'skillsDir'> & {
  dir: string
  appVersion: string
  skillsDir: string
}

// two projects sharing one Postgres/Surreal deployment must never cross-recover:
// every infrastructure boundary name embeds the project UUID
export const projectSuffix = (id: string): string => id.replaceAll('-', '')

export const projectDatabaseName = (base: string, id: string): string =>
  `${base.slice(0, 30)}_${projectSuffix(id)}`

export function deriveSystemUrl(databaseUrl: string, projectId: string): string {
  const url = new URL(databaseUrl)
  const base = url.pathname.slice(1)
  url.pathname = `/${base.slice(0, 25)}_dbos_${projectSuffix(projectId)}` // <= Postgres 63-byte identifier
  return url.toString()
}

// project-bound config: the narrowing every production command goes through.
// systemDatabaseUrl exists only here — DBOS recovery has no meaning without an identity.
export type ProjectConfig = OrcConfig & { projectId: string; projectName: string; systemDatabaseUrl: string }

// atomic identity merge into .orc/config.json — preserves every existing setting
export function initializeProject(
  dir: string,
  name: string,
  opts: { force?: boolean } = {},
): { projectId: string; projectName: string } {
  const file = path.join(dir, '.orc', 'config.json')
  let current: Record<string, unknown> = {}
  if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8'))
  if (current.projectId && !opts.force)
    throw new Error(`project already initialized (${file}) — use --force to mint a new identity`)
  const next = { ...current, projectId: randomUUID(), projectName: name }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
  return { projectId: next.projectId, projectName: name }
}

export function requireProject(config: OrcConfig): ProjectConfig {
  const { projectId, projectName } = config
  if (!projectId || !projectName)
    throw new Error("project is not initialized — run 'orc init'")
  return { ...config, projectId, projectName, systemDatabaseUrl: deriveSystemUrl(config.databaseUrl, projectId) }
}

export function loadConfig(dir: string = process.cwd()): OrcConfig {
  const file = path.join(dir, '.orc', 'config.json')
  let fromFile: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`invalid orc config: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const parsed = settingsSchema(dir).safeParse({ ...fromFile, ...envOverrides() })
  if (!parsed.success)
    throw new Error(
      `invalid orc config (env / .orc/config.json): ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  return {
    ...parsed.data,
    dir,
    skillsDir: parsed.data.skillsDir ?? path.join(parsed.data.vaultDir, 'skills'),
    appVersion: APP_VERSION,
  }
}
