import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalMode, AutoHealMode, GroundedApprovalDoor } from '@orc/contracts'
import { deriveSystemUrl, IDENTITY_FILE, initializeProject, loadConfig, requireProject, SETTINGS_FILE } from './config'
import { sh, tmpGitRepo } from './test-helpers'

describe('loadConfig', () => {
  it('reads .orc/config.json overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', SETTINGS_FILE), JSON.stringify({ concurrency: 7, workspaceRoot: 'ws' }))
    const c = loadConfig(dir)
    expect(c.concurrency).toBe(7)
    expect(c.workspaceRoot).toBe('ws')
  })
  it('discovers the nearest initialized ancestor only when no directory is explicit', () => {
    const project = tmpProject({
      projectId: '00000000-0000-4000-8000-000000000001',
      projectName: 'ancestor',
    })
    const nested = path.join(project, 'src', 'nested')
    mkdirSync(nested, { recursive: true })
    const before = process.cwd()
    try {
      process.chdir(nested)
      expect(loadConfig().dir).toBe(project)
      expect(loadConfig().projectName).toBe('ancestor')
      expect(loadConfig(nested).dir).toBe(nested)
      expect(loadConfig(nested).projectName).toBeNull()
    } finally {
      process.chdir(before)
    }
  })

  it('init writes identity to .orc/identity.json, never into the shareable settings file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-identity-'))
    const { projectId } = initializeProject(dir, 'demo')
    expect(JSON.parse(readFileSync(path.join(dir, '.orc', IDENTITY_FILE), 'utf8')).projectId).toBe(projectId)
    const settings = path.join(dir, '.orc', SETTINGS_FILE)
    if (existsSync(settings)) expect(JSON.parse(readFileSync(settings, 'utf8')).projectId).toBeUndefined()
    expect(requireProject(loadConfig(dir)).projectId).toBe(projectId)
  })

  it('identity.json wins over a projectId left in the settings file — a checkout cannot repoint a project', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-identity-win-'))
    mkdirSync(path.join(dir, '.orc'))
    // exactly what `git reset --hard` restores when the settings file is tracked and carries an id
    writeFileSync(path.join(dir, '.orc', SETTINGS_FILE), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000000a', projectName: 'theirs' }))
    writeFileSync(path.join(dir, '.orc', IDENTITY_FILE), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000000b', projectName: 'ours' }))
    expect(requireProject(loadConfig(dir))).toMatchObject({ projectId: '00000000-0000-4000-8000-00000000000b', projectName: 'ours' })
  })

  it('a project whose identity still lives in the settings file keeps loading (pre-split projects)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-identity-legacy-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', SETTINGS_FILE), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000000c', projectName: 'legacy' }))
    expect(requireProject(loadConfig(dir))).toMatchObject({ projectId: '00000000-0000-4000-8000-00000000000c', projectName: 'legacy' })
  })

  it('has sane defaults', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.concurrency).toBe(3)
    expect(c.databaseUrl).toContain('5433')
    expect(c.appVersion).toMatch(/^orc-/)
    expect(c.execAllowlist).toEqual([]) // no allowlist → exec tool is not offered
    expect(c.workspaceSetup).toEqual([]) // no setup → a new worktree is the tracked tree and nothing else
    expect(c.autoHeal).toBe(AutoHealMode.draft)
  })
  it('rejects malformed ORC_CONCURRENCY loudly — orc env is zod-validated', () => {
    withEnv({ ORC_CONCURRENCY: 'abc' }, () => {
      expect(() => loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))).toThrow(/concurrency/)
    })
  })
  it('treats empty env vars as unset (container reality: VAR= is not a value)', () => {
    withEnv({ ORC_CONCURRENCY: '', ORC_DATABASE_URL: '' }, () => {
      const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
      expect(c.concurrency).toBe(3)
      expect(c.databaseUrl).toContain('5433')
    })
  })
  it('validated env wins over file config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', SETTINGS_FILE), JSON.stringify({ concurrency: 7 }))
    withEnv({ ORC_CONCURRENCY: '9' }, () => {
      expect(loadConfig(dir).concurrency).toBe(9)
    })
  })
  it('wraps malformed JSON with the config file path, not a bare SyntaxError', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    const file = path.join(dir, '.orc', SETTINGS_FILE)
    writeFileSync(file, '{nope')
    expect(() => loadConfig(dir)).toThrow(file)
  })
  it('skillsDir defaults under the project dir and honors file override', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    expect(loadConfig(dir).skillsDir).toBe(path.join(dir, 'vault', 'skills'))

    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', SETTINGS_FILE), JSON.stringify({ skillsDir: 'custom/skills' }))
    expect(loadConfig(dir).skillsDir).toBe(path.resolve(dir, 'custom/skills'))
  })
  it('trunkBranch is unset unless the settings file names one — unset means "ask git"', () => {
    // No `.default('main')` on purpose: the trunk is resolved at workspace adoption (git's
    // origin/HEAD first), and a default here would erase the "unset" state that lets a repo whose
    // trunk is `master` or `develop` work without anyone writing it down.
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).trunkBranch).toBeUndefined()
    expect(loadConfig(tmpProject({ trunkBranch: 'develop' })).trunkBranch).toBe('develop')
  })
  it('vaultDir defaults under dir and skillsDir derives from it', () => {
    const c = loadConfig('/proj')
    expect(c.vaultDir).toBe(path.join('/proj', 'vault'))
    expect(c.skillsDir).toBe(path.join('/proj', 'vault', 'skills'))
  })
  it('overriding vaultDir moves skillsDir with it', () => {
    const d = tmpProject({ vaultDir: 'kb' })
    const c = loadConfig(d)
    expect(c.vaultDir).toBe(path.join(d, 'kb'))
    expect(c.skillsDir).toBe(path.join(d, 'kb', 'skills'))
  })
  it('autoHealIterations defaults lean (15) and honors ORC_AUTO_HEAL_ITERATIONS', () => {
    // deliberately far below maxIterations: the sweep is the one recurring auto-drafted spend,
    // and a sweep that genuinely needs more signals 'partial' and continues under runtime grants
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).autoHealIterations).toBe(15)
    withEnv({ ORC_AUTO_HEAL_ITERATIONS: '25' }, () => {
      expect(loadConfig('/tmp/x').autoHealIterations).toBe(25)
    })
  })

  it('maxIterations defaults to 30; file and env override it (env wins)', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).maxIterations).toBe(30)
    const dir = tmpProject({ maxIterations: 12 })
    expect(loadConfig(dir).maxIterations).toBe(12)
    withEnv({ ORC_MAX_ITERATIONS: '40' }, () => {
      expect(loadConfig(dir).maxIterations).toBe(40)
    })
  })
  it('finishChecks defaults to no checks; the config file supplies the commands, no empty ones', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).finishChecks).toEqual([])
    expect(loadConfig(tmpProject({ finishChecks: ['bun run typecheck'] })).finishChecks).toEqual(['bun run typecheck'])
    expect(() => loadConfig(tmpProject({ finishChecks: [''] }))).toThrow()
  })

  it('workspaceSetup is one argv from the config file, no empty words', () => {
    expect(loadConfig(tmpProject({ workspaceSetup: ['bun', 'install', '--frozen-lockfile'] })).workspaceSetup).toEqual(['bun', 'install', '--frozen-lockfile'])
    expect(() => loadConfig(tmpProject({ workspaceSetup: ['bun', ''] }))).toThrow()
  })
  it('execAllowlist reads from the config file — the operator trust boundary — and rejects empty entries', () => {
    // the security-relevant path production uses: allowlist comes from .orc/config.json, not just the default
    const dir = tmpProject({ execAllowlist: ['bun test', 'bun run typecheck'] })
    expect(loadConfig(dir).execAllowlist).toEqual(['bun test', 'bun run typecheck'])
    // an empty entry would make the exec prefix check (`command.startsWith(' ')`) admit any spaced command
    expect(() => loadConfig(tmpProject({ execAllowlist: ['bun test', ''] }))).toThrow()
  })
  it('seeds redactEnv with MCP $NAME secret refs so consented secrets get value-redacted', () => {
    const dir = tmpProject({
      redactEnv: ['MANUAL_SECRET'],
      mcpServers: { notes: { command: 'notes-mcp', env: { AUTH: '$NOTES_CREDENTIAL', PLAIN: 'literal' } } },
    })
    const c = loadConfig(dir)
    expect(c.redactEnv).toContain('MANUAL_SECRET')     // operator list preserved
    expect(c.redactEnv).toContain('NOTES_CREDENTIAL')  // $NAME ref harvested
    expect(c.redactEnv).not.toContain('PLAIN')         // literal env value is not a secret ref
  })
  // Bun's own `.env` pickup is cwd-relative with no upward walk, so `orc` run from a subdirectory —
  // or a supervisor spawned with a different cwd — used to lose every credential the project's .env
  // holds, surfacing much later as `[provider_error] Anthropic API key is missing` inside a run.
  it('loads the PROJECT dir .env, lets ORC_* in it reach config, and never overrides the real env', () => {
    const dir = tmpProject({})
    writeFileSync(path.join(dir, '.env'), '# a comment\nORC_ENVFILE_PROBE="from the file"\nORC_CONCURRENCY=9\n')
    const clear = (): void => { delete process.env.ORC_ENVFILE_PROBE; delete process.env.ORC_CONCURRENCY }
    clear()
    try {
      expect(loadConfig(dir).concurrency).toBe(9) // an ORC_* setting in the file reaches the schema
      expect(process.env.ORC_ENVFILE_PROBE).toBe('from the file') // and a plain secret reaches process.env
      // the shell wins: a value already exported is never clobbered by the file
      clear()
      withEnv({ ORC_ENVFILE_PROBE: 'from the shell', ORC_CONCURRENCY: '4' }, () => {
        expect(loadConfig(dir).concurrency).toBe(4)
        expect(process.env.ORC_ENVFILE_PROBE).toBe('from the shell')
      })
    } finally {
      clear()
    }
  })

  it('maxDepth defaults to 3 and approvalPolicy defaults to manual/empty', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.maxDepth).toBe(3)
    expect(c.approvalPolicy).toEqual({ default: ApprovalMode.manual, rules: [] })
  })
  // The default IS the invariant: only the cli door (which the web UI's reply also records as)
  // satisfies the plan gate unless an operator edits this file. A project that never touches
  // config must behave exactly as it did before the knob existed.
  it('groundedApprovalDoors defaults to [cli] and rejects a door the log never stamps', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    expect(loadConfig(dir).groundedApprovalDoors).toEqual([GroundedApprovalDoor.cli])

    const widened = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(widened, '.orc'), { recursive: true })
    writeFileSync(path.join(widened, '.orc', SETTINGS_FILE), JSON.stringify({ groundedApprovalDoors: ['cli', 'mcp'] }))
    expect(loadConfig(widened).groundedApprovalDoors).toEqual([GroundedApprovalDoor.cli, GroundedApprovalDoor.mcp])

    const bogus = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(bogus, '.orc'), { recursive: true })
    writeFileSync(path.join(bogus, '.orc', SETTINGS_FILE), JSON.stringify({ groundedApprovalDoors: ['web'] }))
    expect(() => loadConfig(bogus)).toThrow()
  })
  it('knowledgePreloadTokens defaults to 1200; ORC_KNOWLEDGE_PRELOAD_TOKENS overrides it, 0 disables preload', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).knowledgePreloadTokens).toBe(1200)
    withEnv({ ORC_KNOWLEDGE_PRELOAD_TOKENS: '300' }, () => {
      expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).knowledgePreloadTokens).toBe(300)
    })
    withEnv({ ORC_KNOWLEDGE_PRELOAD_TOKENS: '0' }, () => {
      expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).knowledgePreloadTokens).toBe(0)
    })
  })

  it('a linked worktree resolves the MAIN checkout as projectRoot and reads its identity', () => {
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'shared')
    const c = loadConfig(worktree)
    expect(c.dir).toBe(worktree)
    expect(c.projectRoot).toBe(main)
    expect(requireProject(c).projectName).toBe('shared')
    // the vault is a projection of the PROJECT — one per repository, not one per checkout
    expect(c.vaultDir).toBe(path.join(main, 'vault'))
    // …but vault/skills is TRACKED SOURCE, so it moves with the branch: flipped from the main
    // checkout's path when a worktree on a branch that ADDS a role skill could not run its own
    // plans (it read main's index and got "unknown skill 'role-finisher'").
    expect(c.skillsDir).toBe(path.join(worktree, 'vault', 'skills'))
  })

  // Re-rooting the vault's relative location only makes sense while the vault IS inside the
  // repository. Measured: a vaultDir of '/srv/orc-vault' re-rooted to '<worktree>/srv/orc-vault',
  // and '../shared-vault' to '<worktree>/../shared-vault' — two directories nobody named. A vault
  // outside the repo is ONE directory for every checkout, and so are the skills in it.
  // The worktree is NESTED here, not a sibling of the main checkout: at equal depth the escaping
  // relative path happens to walk back to the same place, so a sibling fixture cannot see the bug.
  // Unequal depth is the ordinary case anyway — a worktree pool lives wherever the operator put it.
  it('a vaultDir outside the repository keeps its own skills dir — no re-rooting into the checkout', () => {
    const { main } = tmpGitRepo()
    initializeProject(main, 'shared')
    const nested = path.join(path.dirname(main), 'pool', 'wt')
    sh(main, 'worktree', 'add', '-q', '-b', 'nested', nested)
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-vault-outside-'))
    mkdirSync(path.join(nested, '.orc'), { recursive: true })
    writeFileSync(path.join(nested, '.orc', SETTINGS_FILE), JSON.stringify({ vaultDir: outside }))
    expect(loadConfig(nested).vaultDir).toBe(outside)
    expect(loadConfig(nested).skillsDir).toBe(path.join(outside, 'skills'))
  })

  it('an explicit skillsDir in a worktree\'s tracked settings resolves under THAT checkout', () => {
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'shared')
    mkdirSync(path.join(worktree, '.orc'), { recursive: true })
    writeFileSync(path.join(worktree, '.orc', SETTINGS_FILE), JSON.stringify({ skillsDir: 'custom/skills' }))
    expect(loadConfig(worktree).skillsDir).toBe(path.join(worktree, 'custom', 'skills'))
  })
  it('settings still come from the checkout being worked in (they are tracked; a worktree may be ahead)', () => {
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'shared')
    mkdirSync(path.join(worktree, '.orc'), { recursive: true })
    writeFileSync(path.join(worktree, '.orc', SETTINGS_FILE), JSON.stringify({ concurrency: 9 }))
    expect(loadConfig(worktree).concurrency).toBe(9)
  })
  it('outside git, projectRoot equals dir (today\'s behaviour, unchanged)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-plain-'))
    expect(loadConfig(dir).projectRoot).toBe(dir)
  })
  it('init from inside a worktree writes identity to the MAIN checkout, never into the worktree', () => {
    const { main, worktree } = tmpGitRepo()
    const { projectRoot } = initializeProject(worktree, 'from-wt')
    expect(projectRoot).toBe(main)
    expect(existsSync(path.join(main, '.orc', IDENTITY_FILE))).toBe(true)
    expect(existsSync(path.join(worktree, '.orc', IDENTITY_FILE))).toBe(false)
    expect(requireProject(loadConfig(worktree)).projectName).toBe('from-wt')
  })
  it('an unmarked subdirectory of a repo resolves to the repository toplevel, not to itself', () => {
    // With no `.orc` anywhere the upward walk used to end at the starting directory, so orc
    // answered about the subdirectory it was run in: the repository's `.env` went unread and a
    // project minted at the resolved dir landed inside that subdirectory, invisible one level up.
    // Git's toplevel is the honest answer for "which directory is this repo"; `start` remains the
    // fallback outside a repository.
    const { main } = tmpGitRepo()
    const sub = path.join(main, 'sub')
    mkdirSync(sub, { recursive: true })
    const before = process.cwd()
    try {
      process.chdir(sub)
      expect(loadConfig().dir).toBe(realpathSync(main))
      initializeProject(loadConfig().dir, 'toplevel')
      expect(existsSync(path.join(main, '.orc', IDENTITY_FILE))).toBe(true)
      expect(existsSync(path.join(sub, '.orc', IDENTITY_FILE))).toBe(false)
    } finally {
      process.chdir(before)
    }
  })
  it('an orc project initialized in a subdirectory of a repo keeps its own identity', () => {
    // naively re-rooting every dir inside a repo at the main checkout would lose this identity
    // and `orc init` would mint a duplicate at the repo root (measured, 2026-09-14) — --git-dir
    // equals --git-common-dir here (a main checkout, even from a subdirectory), which is the
    // signal that this dir must NOT be re-rooted.
    const { main } = tmpGitRepo()
    const nested = path.join(main, 'apps', 'x')
    mkdirSync(nested, { recursive: true })
    initializeProject(nested, 'nested')
    expect(loadConfig(nested).projectRoot).toBe(nested)
    expect(requireProject(loadConfig(nested)).projectName).toBe('nested')
    expect(existsSync(path.join(main, '.orc', IDENTITY_FILE))).toBe(false)
  })

  it('the .env of the main checkout reaches a worktree; a worktree .env wins over it', () => {
    const { main, worktree } = tmpGitRepo()
    initializeProject(main, 'shared')
    writeFileSync(path.join(main, '.env'), 'ORC_TEST_FROM_MAIN=1\nORC_TEST_SHARED=main\n')
    writeFileSync(path.join(worktree, '.env'), 'ORC_TEST_SHARED=worktree\n')
    // a named function, not an inline `delete`, so TS's control-flow narrowing (which reads a
    // bare `delete process.env.X` as proof the property stays `undefined`) doesn't fight the
    // later assertions — same shape the sibling .env test above already uses.
    const clear = (): void => { delete process.env.ORC_TEST_FROM_MAIN; delete process.env.ORC_TEST_SHARED }
    clear()
    try {
      loadConfig(worktree)
      expect(process.env.ORC_TEST_FROM_MAIN).toBe('1')
      expect(process.env.ORC_TEST_SHARED).toBe('worktree')
    } finally {
      clear()
    }
  })
})

describe('project identity', () => {
  it('loads an uninitialized project but requireProject rejects it', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.projectId).toBeNull()
    expect(() => requireProject(c)).toThrow(/orc init/)
  })

  it('accepts committed project identity', () => {
    const dir = tmpProject({
      projectId: '00000000-0000-4000-8000-000000000001',
      projectName: 'demo',
    })
    expect(requireProject(loadConfig(dir)).projectName).toBe('demo')
  })
})

describe('project-derived infrastructure boundaries', () => {
  const p1 = '00000000-0000-4000-8000-000000000001'
  const p2 = '00000000-0000-4000-8000-000000000002'

  it('different projects get different DBOS system database urls', () => {
    const url = 'postgresql://postgres:orc@localhost:5433/orc'
    expect(deriveSystemUrl(url, p1)).not.toBe(deriveSystemUrl(url, p2))
    expect(deriveSystemUrl(url, p1)).toContain(`/orc_dbos_${p1.replaceAll('-', '')}`)
  })

  it('derived names stay within the Postgres 63-byte identifier limit', () => {
    const url = `postgresql://postgres:orc@localhost:5433/${'x'.repeat(60)}`
    const dbName = new URL(deriveSystemUrl(url, p1)).pathname.slice(1)
    expect(dbName.length).toBeLessThanOrEqual(63)
  })

  it('requireProject derives systemDatabaseUrl from databaseUrl and projectId', () => {
    const dir = tmpProject({ projectId: p1, projectName: 'demo' })
    const c = requireProject(loadConfig(dir))
    expect(c.systemDatabaseUrl).toBe(deriveSystemUrl(c.databaseUrl, p1))
  })
})

describe('initializeProject', () => {
  it('writes identity BESIDE the settings file, leaving the shared settings untouched', () => {
    const dir = tmpProject({ concurrency: 7 })
    initializeProject(dir, 'demo')
    const settings = JSON.parse(readFileSync(path.join(dir, '.orc', SETTINGS_FILE), 'utf8'))
    expect(settings).toEqual({ concurrency: 7 }) // no identity smuggled into the tracked file
    const cfg = requireProject(loadConfig(dir))
    expect(cfg.concurrency).toBe(7)
    expect(cfg.projectId).toMatch(/^[0-9a-f-]{36}$/)
    expect(cfg.projectName).toBe('demo')
  })

  it('refuses to overwrite identity unless forced; force keeps other settings', () => {
    const dir = tmpProject({ concurrency: 7 })
    initializeProject(dir, 'demo')
    const first = requireProject(loadConfig(dir))
    expect(() => initializeProject(dir, 'demo2')).toThrow(/already initialized/)
    initializeProject(dir, 'demo2', { force: true })
    const second = requireProject(loadConfig(dir))
    expect(second.projectId).not.toBe(first.projectId)
    expect(second.projectName).toBe('demo2')
    expect(second.concurrency).toBe(7)
  })

  it('initializes a bare directory with no .orc at all', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    initializeProject(dir, 'fresh')
    expect(requireProject(loadConfig(dir)).projectName).toBe('fresh')
  })
})

describe('knowledge config', () => {
  const withSettings = (settings: Record<string, unknown>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-kcfg-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', SETTINGS_FILE), JSON.stringify(settings))
    return dir
  }
  it('defaults to the git-files backend, accepts null to turn knowledge off, refuses an unknown key', () => {
    expect(loadConfig(withSettings({})).knowledge).toEqual({ plugin: 'git-files', options: {} })
    expect(loadConfig(withSettings({ knowledge: null })).knowledge).toBeNull()
    expect(() => loadConfig(withSettings({ knowledge: { plugin: 'git-files', typo: 1 } }))).toThrow()
  })
})

function tmpProject(cfg: Record<string, unknown>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orc-cfg-'))
  mkdirSync(path.join(d, '.orc'), { recursive: true })
  writeFileSync(path.join(d, '.orc', SETTINGS_FILE), JSON.stringify(cfg))
  return d
}

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
