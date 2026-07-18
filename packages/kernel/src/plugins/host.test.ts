import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ModelProvider } from '@orc/contracts'
import { planFixture, stepFixture } from '@orc/contracts/fixtures'
import { loadConfig } from '../config'
import { grantExtensionTrust, grantMcpTrust } from './trust'
import { createPluginHost } from './host'

let dirs: string[] = []
const temp = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-host-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

const fakeProvider: ModelProvider<unknown> = { costs: {}, languageModel: () => ({}) }

function project(configJson: Record<string, unknown> = {}): string {
  const d = temp()
  mkdirSync(path.join(d, '.orc'), { recursive: true })
  writeFileSync(path.join(d, '.orc', 'config.json'), JSON.stringify(configJson))
  return d
}

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, 'vault', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: a demo skill\n---\nbody`)
}

async function makeHost(d: string) {
  return createPluginHost(loadConfig(d), {
    providers: new Map([['fake', fakeProvider]]),
    executors: new Map([['api-loop', { id: 'api-loop', startTurn: async function* () {} }]]),
  })
}

describe('createPluginHost / refValidator', () => {
  it('valid plan with known refs → no errors', async () => {
    const d = project({ mcpServers: { files: { command: 'bun' } } })
    writeSkill(d, 'good-skill')
    grantMcpTrust('files', { command: 'bun' }, d)
    const host = await makeHost(d)
    const plan = planFixture({ steps: [stepFixture({ skillRefs: ['good-skill'], toolRefs: ['files/read_file'] })] })
    expect(await host.refValidator(plan)).toEqual([])
    await host.shutdown()
  })

  it('collects one error per bad ref', async () => {
    const d = project({ mcpServers: { files: { command: 'bun' } } }) // declared but NOT trusted
    const host = await makeHost(d)
    const plan = planFixture({
      steps: [stepFixture({
        executorRef: 'nope', modelRef: 'ghost/m',
        skillRefs: ['missing-skill'], toolRefs: ['files/x', 'undeclared/y'],
      })],
    })
    const errors = await host.refValidator(plan)
    expect(errors.join('\n')).toContain(`unknown executor 'nope'`)
    expect(errors.join('\n')).toContain(`unknown provider 'ghost'`)
    expect(errors.join('\n')).toContain(`unknown skill 'missing-skill'`)
    expect(errors.join('\n')).toContain(`not trusted`)
    expect(errors.join('\n')).toContain(`undeclared MCP server 'undeclared'`)
    expect(errors).toHaveLength(5)
    await host.shutdown()
  })

  it('rejects isolation tiers that are not implemented', async () => {
    const d = project()
    const host = await makeHost(d)
    const plan = planFixture({ steps: [stepFixture({ isolation: 'worktree' })] })
    expect((await host.refValidator(plan)).join('\n')).toContain(`isolation 'worktree' is not implemented`)
    await host.shutdown()
  })

  it('an invalid skill fails validation with its errors', async () => {
    const d = project()
    const dir = path.join(d, 'vault', 'skills', 'bad-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: WRONG\ndescription: d\n---\nb`)
    const host = await makeHost(d)
    const plan = planFixture({ steps: [stepFixture({ skillRefs: ['bad-skill'] })] })
    expect((await host.refValidator(plan)).join('\n')).toContain(`invalid skill 'bad-skill'`)
    await host.shutdown()
  })

  it('loads trusted extensions and their registrations are visible to validation', async () => {
    const d = project({ extensions: ['exts/reg.ts'] })
    mkdirSync(path.join(d, 'exts'), { recursive: true })
    writeFileSync(path.join(d, 'exts', 'reg.ts'), `
export default {
  id: 'reg',
  activate(api: { registerProvider(id: string, p: unknown): void }) {
    api.registerProvider('extra', { costs: {}, languageModel: () => ({}) })
  },
}
`)
    grantExtensionTrust('exts/reg.ts', d)
    const host = await makeHost(d)
    expect(host.providers.has('extra')).toBe(true)
    const plan = planFixture({ steps: [stepFixture({ modelRef: 'extra/m' })] })
    expect(await host.refValidator(plan)).toEqual([])
    await host.shutdown()
  })

  it('rejects config with a bad mcp server id', () => {
    const d = project({ mcpServers: { 'Bad_Id': { command: 'x' } } })
    expect(() => loadConfig(d)).toThrow()
  })
})
