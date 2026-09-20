import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { atomicWriteFileSync } from './atomic-file'
import { z } from 'zod'
import { errorMessage, ApprovalPolicy, AUTO_HEAL_MODE, AutoHealMode, GROUNDED_APPROVAL_DOOR, GroundedApprovalDoor, MCP_SERVER_ID_RE, McpServerConfig, ModelCost, ProviderConfigs } from '@orc/contracts'
import { gitDirs, gitToplevel } from './git'
import { resolveProjectRoot } from './project-root'

// bump per release — pins DBOS__APPVERSION so recovery survives rebuilds
const APP_VERSION = 'orc-0.1.0'
const DEFAULT_DATABASE_URL = 'postgresql://postgres:orc@localhost:5433/orc'
// The agent-loop budget an AUTHORED step gets when the project sets none. One constant, because
// three places used to spell `30`: this schema, the grounded plan step, and singleStepDraft — so
// raising the project ceiling left the other two behind.
export const DEFAULT_MAX_ITERATIONS = 30

// ONE zod schema resolves all settings — defaults live in .default(), never in ?? chains.
// Input is file config merged with env overrides (env wins); everything orc's own code
// consumes is validated here, loudly. (Env of third-party processes we spawn — MCP
// servers/containers — stays a loose optional record by design: theirs can be absent
// or opaque.) The schema is a factory because path defaults depend on the project dir.
const settingsSchema = (dir: string, projectRoot: string) =>
  z.object({
    projectId: z.uuid().nullable().default(null),
    projectName: z.string().min(1).nullable().default(null),
    redactEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
    databaseUrl: z.url().default(DEFAULT_DATABASE_URL),
    concurrency: z.coerce.number().int().positive().default(3),
    maxDepth: z.coerce.number().int().positive().default(3),
    // default agent-loop budget for AUTHORED steps (single-step template, analyzer step) — plans
    // are frozen data, so this applies at plan-authoring time, never to already-approved plans.
    maxIterations: z.coerce.number().int().positive().default(DEFAULT_MAX_ITERATIONS),
    // half-life for the memory activation derivation (days) — THE calibration knob the neuron
    // ranking needs once real hot/cold data exists. Read-time only: changing it re-ranks and
    // re-heats instantly, rewrites nothing. Threaded to BOTH consumers (store ranking;
    // graph heat via sessions) so the two surfaces always decay at ONE rate.
    memoryHalfLifeDays: z.coerce.number().positive().default(14),
    // preload budget: token budget for the ONE journaled memory_search the loop runs
    // before iteration 1, rendered as a "Known project context" block. 0 = off (skip preload
    // entirely, prompt unchanged) — same escape hatch shape as ambientCapture below.
    memoryPreloadTokens: z.coerce.number().int().nonnegative().default(800),
    // the embedding model for SEMANTIC memory retrieval, as a 'provider/model' ref. '' disables it
    // (keyword-only, the prior behaviour). Default is the LARGE local Ollama encoder: the retrieval
    // floor (SEMANTIC_FLOOR, 0.495) was tuned on mxbai vectors, and under the smaller all-minilm a
    // known-good probe measured best cosine 0.4015 — below the floor, so the semantic arm silently
    // returned nothing on a default config. Swap via config or ORC_MEMORY_EMBED_MODEL. A model
    // change needs `orc memory rebuild` to re-embed; vectors from different models don't compare.
    memoryEmbedModel: z.string().default('ollama/mxbai-embed-large'),
    // Agent-loop budget for the REACTOR-DRAFTED heal sweep, deliberately far below maxIterations:
    // the sweep is the one recurring auto-drafted spend, and the measured 9-note sweep used well
    // under 20 iterations of the 60 the general default granted (2026-08-04). A sweep that
    // genuinely needs more signals `partial` and continues through the runtime's continuation
    // grants — lean by default, self-extending under evidence, never silently over-provisioned.
    memorySweepIterations: z.coerce.number().int().positive().default(15),
    // the model that DISTILS a finished task's step outcomes into one durable note, as a
    // 'provider/model' ref. '' (default) = extractive promotion (glued bullets, zero model calls);
    // set it (e.g. 'anthropic/claude-haiku-4-5') to have the out-of-band lifecycle synthesise a
    // coherent note instead. A per-task cost, deliberately opt-in — it runs off the agent turn budget.
    memoryConsolidateModel: z.string().default(''),
    // ambient capture kill switch: displaces the manual step-report protocol rule —
    // successful steps auto-persist their signal summary as an expirable plan note, at zero
    // model-call cost. z.stringbool(), NOT z.coerce.boolean(): coerce turns the env string
    // 'false' into `true` (any non-empty string is truthy), which would make the switch inoperable.
    ambientCapture: z.union([z.boolean(), z.stringbool()]).default(true),
    approvalPolicy: ApprovalPolicy.prefault({}), // {} isn't the full output shape — prefault reparses it, applying ApprovalPolicy's own field defaults
    // which doors' approvals satisfy the grounded plan gate (Kernel.approvedPlanHash). Default
    // ['cli'] is today's exact behaviour and covers the web UI too (its replies record 'cli').
    // Nonempty because an empty list would make the gate unsatisfiable through every door at once.
    // Adding 'mcp' lets the agent driving that door approve plans it authored — an operator's
    // decision, taken here in the config FILE, never through anything a model can say.
    groundedApprovalDoors: z.array(GroundedApprovalDoor).nonempty().default([GROUNDED_APPROVAL_DOOR.cli]),
    workspaceRoot: z.string().default(path.join(dir, '.orc', 'workspaces')),
    // The branch this project treats as trunk — the fact a workspace's `onTrunk` is captured
    // against at adoption, and the branch `orc ws` branches off. Deliberately NO `.default('main')`:
    // unset is a meaningful state ("ask git": origin/HEAD via defaultBranch), and a default here
    // would answer 'main' for a repo whose trunk is `master` or `develop` without anyone noticing.
    // Set it when git cannot be asked (no remote) or when the remote's HEAD is not the operator's trunk.
    trunkBranch: z.string().min(1).optional(),
    // operator-allowlisted commands steps may run via the `exec` tool (e.g. "bun test",
    // "bun run typecheck"). Empty = the tool is not offered at all. Without this, acceptance
    // criteria like "tests green" are structurally unverifiable by every step: implementers
    // ship unexecuted tests and an honest auditor can only refuse to certify.
    execAllowlist: z.array(z.string().min(1)).default([]),
    // ONE argv `orc ws new` runs inside the fresh worktree before recording it (e.g. ["bun",
    // "install", "--frozen-lockfile"]). `git worktree add` yields the tracked tree and nothing
    // else: the first run in such a tree spent $1.92 and parked because `bun test` could not
    // resolve a workspace package and `bun install` was not on the exec allowlist.
    workspaceSetup: z.array(z.string().min(1)).default([]),
    // commands the kernel-appended checks step runs before the finish step; [] = no checks step
    finishChecks: z.array(z.string().min(1)).default([]),
    // append the commit step to every frozen grounded plan: the run commits its own diff and
    // restamps the notes it wrote (the truthful-stamp pipeline). Default off like every capability
    // gate here — committing an operator's repo is an outward action they opt into.
    autoCommit: z.union([z.boolean(), z.stringbool()]).default(false),
    // React to a recorded out-of-task commit (the auto-heal reactor). Default 'draft-sweep':
    // the restamp half is free and silent; the LLM half only ever appears as a DRAFTED task the
    // human approves — so the default spends nothing on its own, unlike autoCommit above whose
    // default-off gates an outward git action. 'off' restores commits-as-records-only.
    autoHeal: AutoHealMode.default(AUTO_HEAL_MODE.draftSweep),
    ollamaBaseUrl: z.url().default('http://localhost:11434'),
    projectDbUrl: z.string().default('ws://127.0.0.1:8000/rpc'),
    // ceiling for the surreal driver's initial dial — the driver does not reject unreachable
    // endpoints on its own (measured: still pending after 400s against a closed port), so this
    // guard IS the failure path for a down read model. Tests point at dead endpoints on purpose
    // and lower it so the designed failure fits their budget.
    projectDbConnectTimeoutMs: z.coerce.number().int().positive().default(5000),
    projectDbName: z.string().default('memory'),
    projectDbNamespace: z.string().default('orc'),
    projectDbUser: z.string().default('root'),
    projectDbPassword: z.string().default('orc'),
    costOverrides: z.record(z.string(), z.record(z.string(), ModelCost)).default({}),
    providers: ProviderConfigs.default({}),
    vaultDir: z.string().default(path.join(projectRoot, 'vault')).transform(p => path.resolve(projectRoot, p)),
    // TREE-scoped, unlike the vault it sits inside: `vault/skills` is TRACKED SOURCE (the
    // .gitignore exception for authored content), so it moves with the branch, while the vault
    // PROJECTION (memory/, tasks/) is one per project and rebuilt from the log. Resolved against
    // `dir` — the checkout being worked in — not projectRoot. Measured: from a linked worktree this
    // gave the MAIN checkout's path, so a branch that ADDS a role skill could not run its own
    // plans; every step declaring it failed with "unknown skill 'role-finisher'" until the branch
    // merged. Same rule as the drift probe and the commit tool, which also read the working tree.
    skillsDir: z.string().optional().transform(p => (p === undefined ? undefined : path.resolve(dir, p))),
    extensions: z.array(z.string()).default([]),
    mcpServers: z.record(z.string().regex(MCP_SERVER_ID_RE), McpServerConfig).default({}),
  })

// The vault directory as THIS checkout sees it, for deriving the tree-scoped skills dir.
// Re-rooting is only sound while the vault lives INSIDE the repository, which is the default
// (<projectRoot>/vault) and every in-repo override (kb/). A vault the operator put elsewhere is ONE
// directory for every checkout — and so are the skills in it — so it is returned unchanged.
// Measured, both mis-rootings this guard removes: vaultDir '/srv/orc-vault' became
// '<worktree>/srv/orc-vault', and '../shared-vault' became '<worktree>/../shared-vault'. Neither
// path was named by anyone. (`path.relative` answers with an ABSOLUTE path across drives, hence
// both terms.)
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
    memoryHalfLifeDays: process.env.ORC_MEMORY_HALF_LIFE_DAYS,
    memoryPreloadTokens: process.env.ORC_MEMORY_PRELOAD_TOKENS,
    memoryEmbedModel: process.env.ORC_MEMORY_EMBED_MODEL,
    memorySweepIterations: process.env.ORC_MEMORY_SWEEP_ITERATIONS,
    memoryConsolidateModel: process.env.ORC_MEMORY_CONSOLIDATE_MODEL,
    ambientCapture: process.env.ORC_AMBIENT_CAPTURE,
    autoCommit: process.env.ORC_AUTO_COMMIT,
    autoHeal: process.env.ORC_AUTO_HEAL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    projectDbUrl: process.env.ORC_PROJECT_DB_URL,
    projectDbConnectTimeoutMs: process.env.ORC_PROJECT_DB_CONNECT_TIMEOUT_MS,
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
  projectRoot: string
  appVersion: string
  skillsDir: string
}

// two projects sharing one Postgres/Surreal deployment must never cross-recover:
// every infrastructure boundary name embeds the project UUID
export const projectSuffix = (id: string): string => id.replaceAll('-', '')

export const projectDatabaseName = (base: string, id: string): string =>
  `${base.slice(0, 30)}_${projectSuffix(id)}`

// Env values written as "$NAME" in mcpServers pull a secret from orc's own environment and hand it
// verbatim to a third-party server (mcp-client's resolveEnv). Those exact secret VALUES must be
// redacted from the canonical event log even though their NAMES rarely match the _KEY/_TOKEN/...
// suffix heuristic — the operator consented to the server RECEIVING the secret, not to it landing
// in the log if a hostile/buggy/injected server echoes it back in a tool result. Seeded into
// redactEnv so the redactor value-redacts every consented MCP secret automatically.
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

// project-bound config: the narrowing every production command goes through.
// systemDatabaseUrl exists only here — DBOS recovery has no meaning without an identity.
export type ProjectConfig = OrcConfig & { projectId: string; projectName: string; systemDatabaseUrl: string }

// Identity is per REPOSITORY (the main checkout's file); settings are tracked and travel with
// each checkout. They used to live in one file, and that file is committed — so a clone, a
// `git worktree add`, or any `git reset --hard` restored ANOTHER
// machine's projectId, and every command silently repointed at that project. `orc purge` acts on
// whatever the resolved config names, so this is not cosmetic: it destroyed a live project's
// history once, and the bench harness carries three separate workarounds for it.
//
// config.json (tracked) now carries settings only. identity.json is covered by the existing
// `.orc/*` ignore, so it can never be committed and can never be restored over.
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
  // Identity belongs to the repository, so an init run from a worktree lands in the main checkout —
  // otherwise the worktree would mint a second project for the same repo (the same failure the
  // repository-root rule exists to prevent).
  const projectRoot = resolveProjectRoot(dir, gitDirs(dir))
  const file = path.join(projectRoot, '.orc', IDENTITY_FILE)
  const current = identityOf(projectRoot).projectId
  if (current && !opts.force)
    throw new Error(`project already initialized (${file}) — use --force to mint a new identity`)
  const identity = { projectId: randomUUID(), projectName: name }
  atomicWriteFileSync(file, `${JSON.stringify(identity, null, 2)}\n`)
  return { ...identity, projectRoot }
}

// A CLASS, not a message to match on: the entry point gives this refusal its own exit code, and a
// caller comparing sentences would break the day the wording is improved.
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
    // Nothing is marked anywhere above: the REPOSITORY is the project, not whichever directory the
    // command happened to run in. Without this, orc run from a subdirectory of a repo that has no
    // `.orc` yet resolved to that subdirectory — so the repository's `.env` was never read (Bun's
    // own pickup is cwd-relative, which is exactly what loadProjectEnv below exists to fix) and a
    // project minted at the resolved dir would land inside the subdirectory, invisible one level up.
    // Outside a repository there is nothing to ask, so `start` stays the last resort.
    if (parent === current) return gitToplevel(start) ?? path.resolve(start)
    current = parent
  }
}

// Bun auto-loads `.env` from process.cwd() ONLY — no walk upward (measured: a `.env` one directory
// above is not read). So `orc` invoked from a subdirectory, or a supervisor spawned with a
// different cwd, silently lost every credential the project's own `.env` holds — and nothing said
// so, because auth is resolved lazily inside the executor step (provider-anthropic reads
// ANTHROPIC_API_KEY / ORC_ANTHROPIC_AUTH off process.env at request time), so the failure surfaced
// as `[provider_error] Anthropic API key is missing` in a run, not as a startup error.
//
// Loaded here rather than at each entry point because loadConfig is the ONE place that resolves
// the project dir, and it runs before envOverrides() (so a project `.env` can set ORC_*) and
// before openStorage snapshots process.env for redaction (so a secret from the file is redacted
// like any other). The real environment always wins — a file must not override the shell.
// ponytail: `.env` only; add `.env.local`/`.env.<mode>` if a deployment ever needs the split.
const loadProjectEnv = (dir: string): void => {
  const file = path.join(dir, '.env')
  if (!existsSync(file)) return
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8'))))
    if (process.env[k] === undefined && typeof v === 'string') process.env[k] = v
}

export function loadConfig(explicitDir?: string): OrcConfig {
  const dir = explicitDir ?? findProjectDir(process.cwd())
  // The repository's main checkout. Identity is gitignored and lives ONLY there, so a linked
  // worktree — which carries the tracked settings but no identity — used to resolve to itself
  // and demand `orc init`, i.e. a second project for the same repo. project-root.ts holds the rule.
  const projectRoot = resolveProjectRoot(dir, gitDirs(dir))
  // the worktree's own .env first (a local override), then the project's — first writer wins,
  // and the real environment always beats both (loadProjectEnv never overwrites)
  loadProjectEnv(dir)
  if (projectRoot !== dir) loadProjectEnv(projectRoot)
  const fromFile = readJson(path.join(dir, '.orc', SETTINGS_FILE))
  // identity LAST: it is the one file that names WHICH project this directory is, so a projectId
  // that somehow reached the tracked settings can never override the local identity.
  const parsed = settingsSchema(dir, projectRoot).safeParse({ ...fromFile, ...identityOf(projectRoot), ...envOverrides() })
  if (!parsed.success)
    throw new Error(
      `invalid orc config (env / .orc/config.json): ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  return {
    ...parsed.data,
    // consented MCP secrets ($NAME refs) join the operator's redactEnv so their values never reach the log
    redactEnv: [...new Set([...parsed.data.redactEnv, ...mcpSecretEnvNames(parsed.data.mcpServers)])],
    dir,
    projectRoot,
    // the vault's own RELATIVE location, re-rooted in this checkout: in a main checkout
    // dir === projectRoot, so this is byte-identical to <vaultDir>/skills (including a vaultDir
    // override such as kb/); in a worktree it is <worktree>/vault/skills. See the schema field.
    skillsDir: parsed.data.skillsDir ?? path.join(reRootedVault(dir, projectRoot, parsed.data.vaultDir), 'skills'),
    appVersion: APP_VERSION,
  }
}
