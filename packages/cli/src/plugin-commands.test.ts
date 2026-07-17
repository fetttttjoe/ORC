import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpHub } from '@orc/mcp-client'
import { createPluginHost, grantTrust, loadConfig, loadTrust } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
import { buildProgram, openKernel } from './main'

const FIXTURE = fileURLToPath(new URL('../../../plugins/mcp-client/src/fixture-server.ts', import.meta.url))

const dbs: Array<{ drop: () => Promise<void> }> = []
let dirs: string[] = []
afterAll(async () => { for (const d of dbs) await d.drop() })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; mock.restore() })

function project(configJson: Record<string, unknown>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orc-cli-'))
  dirs.push(d)
  mkdirSync(path.join(d, '.orc'), { recursive: true })
  writeFileSync(path.join(d, '.orc', 'config.json'), JSON.stringify(configJson))
  return d
}

async function makeCli(dir: string) {
  const db = await createTestDb()
  dbs.push(db)
  const config = { ...loadConfig(dir), databaseUrl: db.url }
  const host = await createPluginHost(config, {
    providers: new Map([['fake', { costs: {}, languageModel: () => ({}) }]]),
    executors: new Map([['api-loop', { id: 'api-loop', startTurn: async function* () {} } as never]]),
  })
  const hub = createMcpHub(config.mcpServers, new Set(host.trust.mcp))
  const kernel = await openKernel(db.url, { refValidator: host.refValidator })
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  const run = (...args: string[]) =>
    buildProgram(kernel, undefined, { host, hub, config }).parseAsync(args, { from: 'user' })
  return { run, lines, dir, host, hub }
}

describe('plugin commands', () => {
  it('orc skills lists valid and invalid skills', async () => {
    const dir = project({})
    const skill = path.join(dir, 'vault', 'skills', 'demo-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: demo-skill\ndescription: lists things\n---\nbody`)
    const { run, lines } = await makeCli(dir)
    await run('skills')
    expect(lines.join('\n')).toContain('demo-skill')
    expect(lines.join('\n')).toContain('lists things')
  })

  it('orc mcp list shows trust state; orc mcp trust flips it', async () => {
    const dir = project({ mcpServers: { fixture: { command: 'bun', args: [FIXTURE] } } })
    const { run, lines } = await makeCli(dir)
    await run('mcp', 'list')
    expect(lines.join('\n')).toContain('fixture')
    expect(lines.join('\n')).toContain('untrusted')
    await run('mcp', 'trust', 'fixture')
    expect(loadTrust(dir).mcp).toEqual(['fixture'])
  })

  it('orc mcp tools spawns a trusted server and lists tools with a vetting warning', async () => {
    const dir = project({ mcpServers: { fixture: { command: 'bun', args: [FIXTURE] } } })
    grantTrust('mcp', 'fixture', dir)
    const { run, lines, hub } = await makeCli(dir)
    await run('mcp', 'tools', 'fixture')
    expect(lines.join('\n')).toContain('echo')
    expect(lines.join('\n').toLowerCase()).toContain('vet')
    await hub.close()
  })

  it('orc ext trust grants and orc ext list shows state', async () => {
    const dir = project({ extensions: ['exts/a.ts'] })
    const { run, lines } = await makeCli(dir)
    await run('ext', 'list')
    expect(lines.join('\n')).toContain('untrusted')
    await run('ext', 'trust', 'exts/a.ts')
    expect(loadTrust(dir).extensions).toEqual(['exts/a.ts'])
  })

  it('propose rejects a plan referencing an untrusted server (wired refValidator)', async () => {
    const dir = project({ mcpServers: { fixture: { command: 'bun', args: [FIXTURE] } } })
    const { run, lines, dir: d } = await makeCli(dir)
    await run('new', 'task with tools')
    const taskId = lines[0]!
    const draftFile = path.join(d, 'draft.json')
    writeFileSync(draftFile, JSON.stringify({
      strategyRef: 'template:single', costEstimateUSD: null,
      steps: [{
        id: 's1', role: 'worker', title: 't', instructions: 'i', executorRef: 'api-loop',
        modelRef: 'fake/m', skillRefs: [], toolRefs: ['fixture/echo'], isolation: 'local',
        zone: [], maxIterations: 1, dependsOn: [],
      }],
    }))
    await expect(run('propose', taskId, '--file', draftFile)).rejects.toThrow(/not trusted/)
  })
})
