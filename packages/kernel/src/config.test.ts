import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GROUNDED_APPROVAL_DOOR } from '@orc/contracts'
import { deriveSystemUrl, initializeProject, loadConfig, projectDatabaseName, requireProject, type OrcConfig } from './config'

describe('loadConfig', () => {
  it('reads .orc/config.json overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ concurrency: 7, workspaceRoot: 'ws' }))
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
    expect(JSON.parse(readFileSync(path.join(dir, '.orc', 'identity.json'), 'utf8')).projectId).toBe(projectId)
    const settings = path.join(dir, '.orc', 'config.json')
    if (existsSync(settings)) expect(JSON.parse(readFileSync(settings, 'utf8')).projectId).toBeUndefined()
    expect(requireProject(loadConfig(dir)).projectId).toBe(projectId)
  })

  it('identity.json wins over a projectId left in the settings file — a checkout cannot repoint a project', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-identity-win-'))
    mkdirSync(path.join(dir, '.orc'))
    // exactly what `git reset --hard` restores when the settings file is tracked and carries an id
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000000a', projectName: 'theirs' }))
    writeFileSync(path.join(dir, '.orc', 'identity.json'), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000000b', projectName: 'ours' }))
    expect(requireProject(loadConfig(dir))).toMatchObject({ projectId: '00000000-0000-4000-8000-00000000000b', projectName: 'ours' })
  })

  it('a project whose identity still lives in the settings file keeps loading (pre-split projects)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-identity-legacy-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ projectId: '00000000-0000-4000-8000-00000000000c', projectName: 'legacy' }))
    expect(requireProject(loadConfig(dir))).toMatchObject({ projectId: '00000000-0000-4000-8000-00000000000c', projectName: 'legacy' })
  })

  it('has sane defaults', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.concurrency).toBe(3)
    expect(c.databaseUrl).toContain('5433')
    expect(c.appVersion).toMatch(/^orc-/)
    expect(c.execAllowlist).toEqual([]) // no allowlist → exec tool is not offered
    // draft-sweep by default is deliberate: the reactor's free half runs silently and its LLM
    // half only ever appears as a DRAFTED task — the default spends nothing on its own
    expect(c.autoHeal).toBe('draft-sweep')
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
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ concurrency: 7 }))
    withEnv({ ORC_CONCURRENCY: '9' }, () => {
      expect(loadConfig(dir).concurrency).toBe(9)
    })
  })
  it('wraps malformed JSON with the config file path, not a bare SyntaxError', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    const file = path.join(dir, '.orc', 'config.json')
    writeFileSync(file, '{nope')
    expect(() => loadConfig(dir)).toThrow(file)
  })
  it('skillsDir defaults under the project dir and honors file override', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    expect(loadConfig(dir).skillsDir).toBe(path.join(dir, 'vault', 'skills'))

    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ skillsDir: 'custom/skills' }))
    expect(loadConfig(dir).skillsDir).toBe(path.resolve(dir, 'custom/skills'))
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
  const projectDbCases: Array<{ key: keyof OrcConfig; dflt: string; env: string; override: string }> = [
    // memoryEmbedModel defaults to the LARGE local encoder: SEMANTIC_FLOOR (0.495) was tuned on
    // mxbai vectors, and under all-minilm a known-good probe measured best cosine 0.4015 — the
    // semantic arm silently returned nothing on the out-of-the-box config.
    { key: 'memoryEmbedModel', dflt: 'ollama/mxbai-embed-large', env: 'ORC_MEMORY_EMBED_MODEL', override: 'ollama/nomic-embed-text' },
    { key: 'projectDbUrl', dflt: 'ws://127.0.0.1:8000/rpc', env: 'ORC_PROJECT_DB_URL', override: 'ws://db:8000/rpc' },
    { key: 'projectDbName', dflt: 'memory', env: 'ORC_PROJECT_DB_NAME', override: 't_isolated' },
    { key: 'projectDbNamespace', dflt: 'orc', env: 'ORC_PROJECT_DB_NAMESPACE', override: 't_ns' },
    { key: 'projectDbUser', dflt: 'root', env: 'ORC_PROJECT_DB_USER', override: 'admin' },
    { key: 'projectDbPassword', dflt: 'orc', env: 'ORC_PROJECT_DB_PASSWORD', override: 'secret' },
  ]
  for (const { key, dflt, env, override } of projectDbCases) {
    it(`defaults ${key} and honors the ${env} override`, () => {
      expect(loadConfig('/tmp/x')[key]).toBe(dflt)
      withEnv({ [env]: override }, () => {
        expect(loadConfig('/tmp/x')[key]).toBe(override)
      })
    })
  }
  it('maxIterations defaults to 30; file and env override it (env wins)', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).maxIterations).toBe(30)
    const dir = tmpProject({ maxIterations: 12 })
    expect(loadConfig(dir).maxIterations).toBe(12)
    withEnv({ ORC_MAX_ITERATIONS: '40' }, () => {
      expect(loadConfig(dir).maxIterations).toBe(40)
    })
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
    expect(c.approvalPolicy).toEqual({ default: 'manual', rules: [] })
  })
  // The default IS the invariant: only the cli door (which the web UI's reply also records as)
  // satisfies the plan gate unless an operator edits this file. A project that never touches
  // config must behave exactly as it did before the knob existed.
  it('groundedApprovalDoors defaults to [cli] and rejects a door the log never stamps', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    expect(loadConfig(dir).groundedApprovalDoors).toEqual([GROUNDED_APPROVAL_DOOR.cli])

    const widened = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(widened, '.orc'), { recursive: true })
    writeFileSync(path.join(widened, '.orc', 'config.json'), JSON.stringify({ groundedApprovalDoors: ['cli', 'mcp'] }))
    expect(loadConfig(widened).groundedApprovalDoors).toEqual([GROUNDED_APPROVAL_DOOR.cli, GROUNDED_APPROVAL_DOOR.mcp])

    const bogus = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(bogus, '.orc'), { recursive: true })
    writeFileSync(path.join(bogus, '.orc', 'config.json'), JSON.stringify({ groundedApprovalDoors: ['web'] }))
    expect(() => loadConfig(bogus)).toThrow()
  })
  it('ambientCapture defaults true; ORC_AMBIENT_CAPTURE=false disables it (the kill switch)', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).ambientCapture).toBe(true)
    withEnv({ ORC_AMBIENT_CAPTURE: 'false' }, () => {
      expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).ambientCapture).toBe(false)
    })
  })
  it('memoryPreloadTokens defaults to 800; ORC_MEMORY_PRELOAD_TOKENS overrides it, 0 disables preload', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).memoryPreloadTokens).toBe(800)
    withEnv({ ORC_MEMORY_PRELOAD_TOKENS: '300' }, () => {
      expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).memoryPreloadTokens).toBe(300)
    })
    withEnv({ ORC_MEMORY_PRELOAD_TOKENS: '0' }, () => {
      expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).memoryPreloadTokens).toBe(0)
    })
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

  it('different projects get different Surreal database names', () => {
    expect(projectDatabaseName('memory', p1)).not.toBe(projectDatabaseName('memory', p2))
    expect(projectDatabaseName('memory', p1)).toBe(`memory_${p1.replaceAll('-', '')}`)
  })

  it('different projects get different DBOS system database urls', () => {
    const url = 'postgresql://postgres:orc@localhost:5433/orc'
    expect(deriveSystemUrl(url, p1)).not.toBe(deriveSystemUrl(url, p2))
    expect(deriveSystemUrl(url, p1)).toContain(`/orc_dbos_${p1.replaceAll('-', '')}`)
  })

  it('derived names stay within the Postgres 63-byte identifier limit', () => {
    const url = `postgresql://postgres:orc@localhost:5433/${'x'.repeat(60)}`
    const dbName = new URL(deriveSystemUrl(url, p1)).pathname.slice(1)
    expect(dbName.length).toBeLessThanOrEqual(63)
    expect(projectDatabaseName('y'.repeat(60), p1).length).toBeLessThanOrEqual(63)
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
    const settings = JSON.parse(readFileSync(path.join(dir, '.orc', 'config.json'), 'utf8'))
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

function tmpProject(cfg: Record<string, unknown>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orc-cfg-'))
  mkdirSync(path.join(d, '.orc'), { recursive: true })
  writeFileSync(path.join(d, '.orc', 'config.json'), JSON.stringify(cfg))
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
