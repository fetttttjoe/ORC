import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExtensionApi } from '@orc/contracts'
import { ExtensionHost } from './extensions'
import { grantExtensionTrust, isExtensionTrusted, loadTrust } from './trust'

let dirs: string[] = []
const temp = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-ext-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; mock.restore() })

function fakeApi() {
  const registered: string[] = []
  const api: ExtensionApi = {
    registerProvider: id => { registered.push(`provider:${id}`) },
    registerExecutor: id => { registered.push(`executor:${id}`) },
    registerAnalyzer: id => { registered.push(`analyzer:${id}`) },
    on: hook => { registered.push(`on:${hook}`) },
  }
  return { api, registered }
}

const EXT = (marker: string) => `
import type { ExtensionApi, ExtensionManifest } from '@orc/contracts'
import { value } from './dep'
const manifest: ExtensionManifest = {
  id: 'demo',
  activate(api: ExtensionApi) {
    api.registerProvider('${marker}-' + value, { costs: {}, languageModel: () => ({}) })
  },
}
export default manifest
`

function writeExt(root: string, depValue: string, marker = 'p'): string {
  const dir = path.join(root, 'exts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'dep.ts'), `export const value = '${depValue}'\n`)
  const file = path.join(dir, 'main.ts')
  writeFileSync(file, EXT(marker))
  return file
}

describe('ExtensionHost', () => {
  it('refuses untrusted extensions with a warning; loads trusted ones and activates', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const root = temp()
    const file = writeExt(root, 'v1')
    const { api, registered } = fakeApi()
    const host = new ExtensionHost(api)

    await host.load([file], () => false, root) // not trusted
    expect(host.loaded).toEqual([])
    expect(warn).toHaveBeenCalled()

    await host.load([file], () => true, root) // trusted
    expect(host.loaded.map(l => l.manifest.id)).toEqual(['demo'])
    expect(registered).toEqual(['provider:p-v1'])
  })

  it('skips a file with a bad default export, loudly, without throwing', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const root = temp()
    const dir = path.join(root, 'exts')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'broken.ts')
    writeFileSync(file, `export default { nope: true }\n`)
    const { api } = fakeApi()
    const host = new ExtensionHost(api)
    await host.load([file], () => true, root)
    expect(host.loaded).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('reload() rechecks trust before loading changed local dependencies', async () => {
    const root = temp()
    writeExt(root, 'v1')
    const declared = 'exts/main.ts'
    grantExtensionTrust(declared, root)
    const trusted = () => isExtensionTrusted(loadTrust(root), declared, root)
    const { api, registered } = fakeApi()
    const host = new ExtensionHost(api)
    await host.load([declared], trusted, root)
    expect(registered).toEqual(['provider:p-v1'])

    writeExt(root, 'v2')
    await host.reload()
    expect(registered).toEqual(['provider:p-v1'])

    grantExtensionTrust(declared, root)
    await host.reload()
    expect(registered).toEqual(['provider:p-v1', 'provider:p-v2'])
  })

  it('shutdown() calls deactivate', async () => {
    const root = temp()
    const dir = path.join(root, 'exts')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'd.ts')
    writeFileSync(file, `
import { appendFileSync } from 'node:fs'
export default {
  id: 'd',
  activate() {},
  deactivate() { appendFileSync('${path.join(root, 'out.txt').replaceAll('\\\\', '/')}', 'bye') },
}
`)
    const host = new ExtensionHost(fakeApi().api)
    await host.load([file], () => true, root)
    await host.shutdown()
    expect(require('node:fs').readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe('bye')
  })
})
