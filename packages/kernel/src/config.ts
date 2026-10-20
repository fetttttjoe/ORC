import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { atomicWriteFileSync } from './atomic-file'
import { z } from 'zod'
import { errorMessage, ApprovalPolicy, AutoHealMode, DEFAULT_KNOWLEDGE_PLUGIN, GroundedApprovalDoor, KnowledgeConfig, MCP_SERVER_ID_RE, McpServerConfig, ModelCost, ProviderConfigs } from '@orc/contracts'
import { gitDirs, gitToplevel } from './git'
import { resolveProjectRoot } from './project-root'

// bump per release — pins DBOS__APPVERSION so recovery survives rebuilds
const APP_VERSION = 'orc-0.1.0'
const DEFAULT_DATABASE_URL = 'postgresql://postgres:orc@localhost:5433/orc'
// one constant for the authored-step budget, shared by schema, grounded step and singleStepDraft
export const DEFAULT_MAX_ITERATIONS = 30

// defaults live in .default(), never in ?? chains; a factory because path defaults need the dir
const settingsSchema = (dir: string, projectRoot: string) =>
  z.object({
    projectId: z.uuid().nullable().default(null),
    projectName: z.string().min(1).nullable().default(null),
    redactEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
    databaseUrl: z.url().default(DEFAULT_DATABASE_URL),
    concurrency: z.coerce.number().int().positive().default(3),
    maxDepth: z.coerce.number().int().positive().default(3),
    // applies at plan-authoring time, never to already-approved plans (frozen data)
    maxIterations: z.coerce.number().int().positive().default(DEFAULT_MAX_ITERATIONS),
    knowledgePreloadTokens: z.coerce.number().int().nonnegative().default(1200),
    // far below maxIterations: a sweep needing more signals `partial` and continues under grants
    autoHealIterations: z.coerce.number().int().positive().default(15),
    approvalPolicy: ApprovalPolicy.prefault({}), // {} isn't the full output shape — prefault reparses it, applying ApprovalPolicy's own field defaults
    // nonempty: [] leaves the plan gate unsatisfiable; the default 'cli' also covers web replies
    groundedApprovalDoors: z.array(z.enum(GroundedApprovalDoor)).nonempty().default([GroundedApprovalDoor.cli]),
    workspaceRoot: z.string().default(path.join(dir, '.orc', 'workspaces')),
    // no .default('main'): unset means ask git (origin/HEAD), and a default would answer wrong
    trunkBranch: z.string().min(1).optional(),
    // empty = the tool is not offered; without it 'tests green' criteria are unverifiable
    execAllowlist: z.array(z.string().min(1)).default([]),
    // ONE argv run in the fresh worktree: `git worktree add` yields the tracked tree and nothing else
    workspaceSetup: z.array(z.string().min(1)).default([]),
    // commands the kernel-appended checks step runs before the finish step; [] = no checks step
    finishChecks: z.array(z.string().min(1)).default([]),
    // default off: committing an operator's repo is an outward action they opt into
    autoCommit: z.union([z.boolean(), z.stringbool()]).default(false),
    autoHeal: z.enum(AutoHealMode).default(AutoHealMode.draft),
    ollamaBaseUrl: z.url().default('http://localhost:11434'),
    costOverrides: z.record(z.string(), z.record(z.string(), ModelCost)).default({}),
    providers: ProviderConfigs.default({}),
    knowledge: KnowledgeConfig.nullable().prefault({ plugin: DEFAULT_KNOWLEDGE_PLUGIN }),
    vaultDir: z.string().default(path.join(projectRoot, 'vault')).transform(p => path.resolve(projectRoot, p)),
    // resolved against `dir`, not projectRoot: a branch adding a role skill must run its own plans
    skillsDir: z.string().optional().transform(p => (p === undefined ? undefined : path.resolve(dir, p))),
    extensions: z.array(z.string()).default([]),
    mcpServers: z.record(z.string().regex(MCP_SERVER_ID_RE), McpServerConfig).default({}),
  })

// a vault outside the repo is one directory for every checkout, so it is returned unchanged
const reRootedVault = (dir: string, projectRoot: string, vaultDir: string): string => {
  const rel = path.relative(projectRoot, vaultDir)
  return rel.startsWith('..') || path.isAbsolute(rel) ? vaultDir : path.join(dir, rel)
}

// container reality: `VAR=` (empty) counts as unset, not as a value
const envOverrides = (): Record<string, string> => {
  const map = {
    databaseUrl: process.env.ORC_DATABASE_URL,
    concurrency: process.env.ORC_CONCURRENCY,
    maxDepth: process.env.ORC_MAX_DEPTH,
    maxIterations: process.env.ORC_MAX_ITERATIONS,
    knowledgePreloadTokens: process.env.ORC_KNOWLEDGE_PRELOAD_TOKENS,
    autoHealIterations: process.env.ORC_AUTO_HEAL_ITERATIONS,
    autoCommit: process.env.ORC_AUTO_COMMIT,
    autoHeal: process.env.ORC_AUTO_HEAL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  }
  return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => Boolean(e[1])))
}

// derived from the schema so a new setting can never drift out of the type
export type OrcConfig = Omit<z.infer<ReturnType<typeof settingsSchema>>, 'skillsDir'> & {
  dir: string
  projectRoot: string
  appVersion: string
  skillsDir: string
}

// two projects on one Postgres deployment must never cross-recover: names embed the UUID
export const projectSuffix = (id: string): string => id.replaceAll('-', '')

// $NAME env refs are value-redacted: a server could echo the consented secret into the log
function mcpSecretEnvNames(mcpServers: Record<string, { env?: Record<string, string> }>): string[] {
  const names = new Set<string>()
  for (const cfg of Object.values(mcpServers))
    for (const v of Object.values(cfg.env ?? {}))
      if (typeof v === 'string' && v.startsWith('$')) names.add(v.slice(1))
  return [...names]
}

export function deriveSystemUrl(databaseUrl: string, projectId: string): string {
  const url = new URL(databaseUrl)
  const base = url.pathname.slice(1)
  url.pathname = `/${base.slice(0, 25)}_dbos_${projectSuffix(projectId)}` // <= Postgres 63-byte identifier
  return url.toString()
}

// systemDatabaseUrl exists only here: DBOS recovery has no meaning without an identity
export type ProjectConfig = OrcConfig & { projectId: string; projectName: string; systemDatabaseUrl: string }

// gitignored, so a clone or reset cannot restore another machine's projectId over it
export const IDENTITY_FILE = 'identity.json'
export const SETTINGS_FILE = 'config.json'

const readJson = (file: string): Record<string, unknown> => {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`invalid orc config: ${file} is not valid JSON (${errorMessage(err)})`)
  }
}

// Only the identity keys, so a stray setting in identity.json cannot shadow the shared file.
const identityOf = (dir: string): Record<string, unknown> => {
  const { projectId, projectName } = readJson(path.join(dir, '.orc', IDENTITY_FILE))
  return {
    ...(projectId !== undefined && { projectId }),
    ...(projectName !== undefined && { projectName }),
  }
}

export function initializeProject(
  dir: string,
  name: string,
  opts: { force?: boolean } = {},
): { projectId: string; projectName: string; projectRoot: string } {
  // identity belongs to the repository: an init from a worktree lands in the main checkout
  const projectRoot = resolveProjectRoot(dir, gitDirs(dir))
  const file = path.join(projectRoot, '.orc', IDENTITY_FILE)
  const current = identityOf(projectRoot).projectId
  if (current && !opts.force)
    throw new Error(`project already initialized (${file}) — use --force to mint a new identity`)
  const identity = { projectId: randomUUID(), projectName: name }
  atomicWriteFileSync(file, `${JSON.stringify(identity, null, 2)}\n`)
  return { ...identity, projectRoot }
}

// a class, not a message: the entry point maps it to its own exit code
export class ProjectNotInitializedError extends Error {
  constructor() {
    super("project is not initialized — run 'orc init'")
    this.name = 'ProjectNotInitializedError'
  }
}

export function requireProject(config: OrcConfig): ProjectConfig {
  const { projectId, projectName } = config
  if (!projectId || !projectName) throw new ProjectNotInitializedError()
  return { ...config, projectId, projectName, systemDatabaseUrl: deriveSystemUrl(config.databaseUrl, projectId) }
}

function findProjectDir(start: string): string {
  let current = path.resolve(start)
  while (true) {
    // either file marks a project dir: identity alone after `orc init`, settings alone in a clone
    if (existsSync(path.join(current, '.orc', IDENTITY_FILE)) || existsSync(path.join(current, '.orc', SETTINGS_FILE)))
      return current
    const parent = path.dirname(current)
    // the REPOSITORY is the project: a subdirectory with no .orc yet must not become its own root
    if (parent === current) return gitToplevel(start) ?? path.resolve(start)
    current = parent
  }
}

// Bun reads .env from cwd only; the real environment always wins over the file
const loadProjectEnv = (dir: string): void => {
  const file = path.join(dir, '.env')
  if (!existsSync(file)) return
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8'))))
    if (process.env[k] === undefined && typeof v === 'string') process.env[k] = v
}

export function loadConfig(explicitDir?: string): OrcConfig {
  const dir = explicitDir ?? findProjectDir(process.cwd())
  const projectRoot = resolveProjectRoot(dir, gitDirs(dir))
  // the worktree's .env first, then the project's: first writer wins, the real env beats both
  loadProjectEnv(dir)
  if (projectRoot !== dir) loadProjectEnv(projectRoot)
  const fromFile = readJson(path.join(dir, '.orc', SETTINGS_FILE))
  // identity last: a projectId that reached the tracked settings must not override it
  const parsed = settingsSchema(dir, projectRoot).safeParse({ ...fromFile, ...identityOf(projectRoot), ...envOverrides() })
  if (!parsed.success)
    throw new Error(
      `invalid orc config (env / .orc/config.json): ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  return {
    ...parsed.data,
    // consented MCP secrets join redactEnv so their values never reach the log
    redactEnv: [...new Set([...parsed.data.redactEnv, ...mcpSecretEnvNames(parsed.data.mcpServers)])],
    dir,
    projectRoot,
    // re-rooted vault location: byte-identical to <vaultDir>/skills in a main checkout
    skillsDir: parsed.data.skillsDir ?? path.join(reRootedVault(dir, projectRoot, parsed.data.vaultDir), 'skills'),
    appVersion: APP_VERSION,
  }
}
