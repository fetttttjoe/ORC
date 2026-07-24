import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deriveSystemUrl, initializeProject, loadConfig, projectDatabaseName, requireProject } from './config'

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

  it('has sane defaults', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.concurrency).toBe(3)
    expect(c.databaseUrl).toContain('5433')
    expect(c.appVersion).toMatch(/^orc-/)
    expect(c.execAllowlist).toEqual([]) // no allowlist → exec tool is not offered
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
  it('defaults projectDbUrl and honors the env override', () => {
    expect(loadConfig('/tmp/x').projectDbUrl).toBe('ws://127.0.0.1:8000/rpc')
    withEnv({ ORC_PROJECT_DB_URL: 'ws://db:8000/rpc' }, () => {
      expect(loadConfig('/tmp/x').projectDbUrl).toBe('ws://db:8000/rpc')
    })
  })
  it('defaults projectDbName and honors the env override', () => {
    expect(loadConfig('/tmp/x').projectDbName).toBe('memory')
    withEnv({ ORC_PROJECT_DB_NAME: 't_isolated' }, () => {
      expect(loadConfig('/tmp/x').projectDbName).toBe('t_isolated')
    })
  })
  it('defaults projectDbNamespace and honors the env override', () => {
    expect(loadConfig('/tmp/x').projectDbNamespace).toBe('orc')
    withEnv({ ORC_PROJECT_DB_NAMESPACE: 't_ns' }, () => {
      expect(loadConfig('/tmp/x').projectDbNamespace).toBe('t_ns')
    })
  })
  it('defaults projectDbUser and honors the env override', () => {
    expect(loadConfig('/tmp/x').projectDbUser).toBe('root')
    withEnv({ ORC_PROJECT_DB_USER: 'admin' }, () => {
      expect(loadConfig('/tmp/x').projectDbUser).toBe('admin')
    })
  })
  it('defaults projectDbPassword and honors the env override', () => {
    expect(loadConfig('/tmp/x').projectDbPassword).toBe('orc')
    withEnv({ ORC_PROJECT_DB_PASSWORD: 'secret' }, () => {
      expect(loadConfig('/tmp/x').projectDbPassword).toBe('secret')
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
  it('maxDepth defaults to 3 and approvalPolicy defaults to manual/empty', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.maxDepth).toBe(3)
    expect(c.approvalPolicy).toEqual({ default: 'manual', rules: [] })
  })
  it('ambientCapture defaults true; ORC_AMBIENT_CAPTURE=false disables it (the kill switch)', () => {
    expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).ambientCapture).toBe(true)
    withEnv({ ORC_AMBIENT_CAPTURE: 'false' }, () => {
      expect(loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-'))).ambientCapture).toBe(false)
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
  it('merges identity into existing config without erasing settings', () => {
    const dir = tmpProject({ concurrency: 7 })
    initializeProject(dir, 'demo')
    const cfg = JSON.parse(readFileSync(path.join(dir, '.orc', 'config.json'), 'utf8'))
    expect(cfg.concurrency).toBe(7)
    expect(cfg.projectId).toMatch(/^[0-9a-f-]{36}$/)
    expect(cfg.projectName).toBe('demo')
  })

  it('refuses to overwrite identity unless forced; force keeps other settings', () => {
    const dir = tmpProject({ concurrency: 7 })
    initializeProject(dir, 'demo')
    const first = JSON.parse(readFileSync(path.join(dir, '.orc', 'config.json'), 'utf8'))
    expect(() => initializeProject(dir, 'demo2')).toThrow(/already initialized/)
    initializeProject(dir, 'demo2', { force: true })
    const second = JSON.parse(readFileSync(path.join(dir, '.orc', 'config.json'), 'utf8'))
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
