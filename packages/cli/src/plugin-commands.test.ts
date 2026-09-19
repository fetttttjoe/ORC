import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpHub } from '@orc/mcp-client'
import { createPluginHost, grantMcpTrust, isMcpTrusted, loadConfig, loadTrust, requireProject } from '@orc/kernel'
import { Door, NO_CHAT } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { openKernel } from './main'
import { cli } from './test-helpers'
import { seedShippedSkills } from './shipped-skills'

const FIXTURE = fileURLToPath(new URL('../../../plugins/mcp-client/src/fixture-server.ts', import.meta.url))

// these tests drive the CLI door, so arrangement names the origin that door names
const CLI = NO_CHAT(Door.cli)

// The shared action validates model refs at the boundary now, so a project that names a model must
// PRICE it — cost-table keys ARE the valid universe, and the old unpriced 'fake/m' is refused.
const PRICED = { costOverrides: { ollama: { m: { inPerMTok: 0, outPerMTok: 0 }, edited: { inPerMTok: 0, outPerMTok: 0 } } } }
const MODEL = 'ollama/m'
const EDITED_MODEL = 'ollama/edited'

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
  const config = requireProject({ ...loadConfig(dir), databaseUrl: db.url, projectId: TEST_PROJECT_ID, projectName: 'test' })
  // seeded the way `orc init` seeds a real project (ONE seeder): the kernel appends a finish step
  // declaring ROLE_SKILL.finisher to every root plan, and refValidator refuses the plan outright
  // when this temp project's skills dir holds nothing
  seedShippedSkills(config.skillsDir)
  const host = await createPluginHost(config, {
    // registered under the id the CONFIG prices: refValidator reads this host, assertKnownModel
    // reads the config's seeded registry, and a plan must satisfy both
    providers: new Map([['ollama', { costs: {}, languageModel: () => ({}) }]]),
    executors: new Map([['api-loop', { id: 'api-loop', startTurn: async function* () {} }]]),
  })
  const hub = createMcpHub(config.mcpServers, (id, cfg) => isMcpTrusted(loadTrust(dir), id, cfg))
  db.onClose(() => hub.close())
  const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, refValidator: host.refValidator })
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(log, CLI)
  const { run, lines } = cli(kernel, undefined, { host, hub, config, log })
  return { run, lines, dir, host, hub, kernel, config }
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
    const store = loadTrust(dir)
    expect(isMcpTrusted(store, 'fixture', { command: 'bun', args: [FIXTURE] })).toBe(true)
    // a changed declaration invalidates the grant without touching trust.json
    expect(isMcpTrusted(store, 'fixture', { command: 'bun', args: ['other.ts'] })).toBe(false)
  })

  it('orc mcp tools spawns a trusted server and lists tools with a vetting warning', async () => {
    const dir = project({ mcpServers: { fixture: { command: 'bun', args: [FIXTURE] } } })
    grantMcpTrust('fixture', { command: 'bun', args: [FIXTURE] }, dir)
    const { run, lines } = await makeCli(dir)
    await run('mcp', 'tools', 'fixture')
    expect(lines.join('\n')).toContain('echo')
    expect(lines.join('\n').toLowerCase()).toContain('vet')
  })

  it('orc ext trust grants content-bound trust; list shows state; changed bytes untrust', async () => {
    const dir = project({ extensions: ['exts/a.ts'] })
    mkdirSync(path.join(dir, 'exts'), { recursive: true })
    const { run, lines } = await makeCli(dir)
    await run('ext', 'list')
    expect(lines.join('\n')).toContain('untrusted')
    writeFileSync(path.join(dir, 'exts', 'a.ts'), 'export default { id: "a", activate() {} }')
    await run('ext', 'trust', 'exts/a.ts')
    expect(loadTrust(dir).extensions.map(r => r.id)).toEqual(['exts/a.ts'])
    lines.length = 0
    await run('ext', 'list')
    expect(lines.join('\n')).toMatch(/^trusted/)

    // changing the entry bytes invalidates the grant — consent is content-bound
    writeFileSync(path.join(dir, 'exts', 'a.ts'), 'export default { id: "a", activate() { /* v2 */ } }')
    lines.length = 0
    await run('ext', 'list')
    expect(lines.join('\n')).toContain('untrusted')
  })

  it('orc ext trust rejects an undeclared path', async () => {
    const dir = project({ extensions: ['exts/a.ts'] })
    const { run } = await makeCli(dir)
    await expect(run('ext', 'trust', 'exts/ghost.ts')).rejects.toThrow(/undeclared/)
  })

  it('propose rejects a plan referencing an untrusted server (wired refValidator)', async () => {
    const dir = project({ ...PRICED, mcpServers: { fixture: { command: 'bun', args: [FIXTURE] } } })
    const { run, lines, dir: d } = await makeCli(dir)
    await run('new', 'task with tools', '--workspace', TEST_WORKSPACE_ID)
    const taskId = must(lines[0], 'task id from new command')
    const draftFile = path.join(d, 'draft.json')
    writeFileSync(draftFile, JSON.stringify({
      strategyRef: 'template:single', costEstimateUSD: null,
      steps: [{
        id: 's1', role: 'worker', title: 't', instructions: 'i', executorRef: 'api-loop',
        modelRef: MODEL, skillRefs: [], toolRefs: ['fixture/echo'], isolation: 'local',
        zone: [], maxIterations: 1, dependsOn: [],
      }],
    }))
    await expect(run('propose', taskId, '--file', draftFile)).rejects.toThrow(/not trusted/)
  })

  it('orc vault render writes the task tree', async () => {
    const dir = project({})
    const { run, lines, kernel, config } = await makeCli(dir)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'demo', spec: 'do it' }, CLI)
    await run('vault', 'render', t.id)
    const idx = path.join(config.vaultDir, 'tasks', t.id, 'index.md')
    expect(existsSync(idx)).toBe(true)
    expect(lines.join('\n')).toContain('vault rendered')
  })

  it('orc vault render rejects an unknown task id', async () => {
    const dir = project({})
    const { run } = await makeCli(dir)
    await expect(run('vault', 'render', '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/no task/)
  })

  it('orc edit rejects --file together with --from-vault instead of silently preferring one', async () => {
    // The vault arm returned before --file was ever read, so an operator who passed both watched
    // their authored draft be ignored and the vault markdown applied under its name.
    const dir = project({})
    const { run, lines } = await makeCli(dir)
    await run('new', 'both sources task', '--workspace', TEST_WORKSPACE_ID)
    const taskId = must(lines[0], 'task id from new command')
    await expect(run('edit', taskId, '--file', path.join(dir, 'draft.json'), '--from-vault'))
      .rejects.toThrow(/pass exactly one/)
  })

  it('orc edit --from-vault picks the numerically highest plan version, not the lexicographic one', async () => {
    const dir = project(PRICED)
    const { run, lines, config } = await makeCli(dir)
    await run('new', 'vault edit task', '--workspace', TEST_WORKSPACE_ID)
    const taskId = must(lines[0], 'task id from new command')
    await run('propose', taskId, '--model', MODEL) // v1
    for (let i = 0; i < 10; i++) await run('edit', taskId, '--model', MODEL) // v2..v11 — plan-v10/plan-v11 must sort after plan-v9 numerically, not lexicographically
    await run('vault', 'render', taskId) // render every plan-vN.md to disk (real vault files, not a mock)

    const planPath = path.join(config.vaultDir, 'tasks', taskId, 'plan-v11.md')
    expect(existsSync(planPath)).toBe(true)
    writeFileSync(planPath, readFileSync(planPath, 'utf8').replaceAll(MODEL, EDITED_MODEL))

    lines.length = 0
    await run('edit', taskId, '--from-vault')
    expect(lines[0]).toContain('plan v12 edited')

    lines.length = 0
    await run('plan', taskId, '--json')
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.version).toBe(12)
    expect(plan.steps[0].modelRef).toBe(EDITED_MODEL)
  })
})
