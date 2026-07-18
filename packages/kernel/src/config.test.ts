import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('derives systemDatabaseUrl from databaseUrl', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.systemDatabaseUrl).toBe(c.databaseUrl.replace(/\/([^/]+)$/, '/$1_dbos_sys'))
  })
  it('reads .orc/config.json overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ concurrency: 7, workspaceRoot: 'ws' }))
    const c = loadConfig(dir)
    expect(c.concurrency).toBe(7)
    expect(c.workspaceRoot).toBe('ws')
  })
  it('has sane defaults', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.concurrency).toBe(3)
    expect(c.databaseUrl).toContain('5433')
    expect(c.appVersion).toMatch(/^orc-/)
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
