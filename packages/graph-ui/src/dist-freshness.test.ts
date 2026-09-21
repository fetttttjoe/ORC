import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureDistFresh, fingerprintSourceDirs, STAMP_FILE, writeStamp } from './dist-freshness'
import { DistVerdict } from './dist-verdict'

const temps: string[] = []
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

function tmpProject(): { root: string; sourceDir: string; distDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orc-dist-freshness-'))
  temps.push(root)
  const sourceDir = path.join(root, 'src')
  const distDir = path.join(root, 'dist')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(path.join(sourceDir, 'main.ts'), 'export const x = 1\n')
  return { root, sourceDir, distDir }
}

const neverBuild = (): Promise<boolean> => { throw new Error('build should not have been called') }

describe('ensureDistFresh — real files in a temp dir, an injected builder', () => {
  it('is missing when dist/index.html is absent, and rebuilds when the injected build succeeds', async () => {
    const { sourceDir, distDir } = tmpProject()
    let built = false
    const result = await ensureDistFresh({
      distDir,
      sourceDirs: [sourceDir],
      build: async () => {
        built = true
        mkdirSync(distDir, { recursive: true })
        writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
        writeStamp(distDir, fingerprintSourceDirs([sourceDir]))
        return true
      },
    })
    expect(result.verdict).toBe(DistVerdict.missing)
    expect(built).toBe(true)
    expect(result).toEqual({ verdict: DistVerdict.missing, rebuilt: true, ok: true })
  })

  it('refuses when dist is missing and the injected build fails', async () => {
    const { sourceDir, distDir } = tmpProject()
    const result = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: async () => false })
    expect(result).toEqual({ verdict: DistVerdict.missing, rebuilt: false, ok: false })
  })

  it('is stale when the stamp does not match the source, rebuilds, and a later check reads the new stamp as fresh', async () => {
    const { sourceDir, distDir } = tmpProject()
    mkdirSync(distDir, { recursive: true })
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
    writeFileSync(path.join(distDir, STAMP_FILE), JSON.stringify({ fingerprint: 'stale-fingerprint' }))
    let builds = 0
    const build = async (): Promise<boolean> => { builds += 1; writeStamp(distDir, fingerprintSourceDirs([sourceDir])); return true }

    const first = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build })
    expect(first).toEqual({ verdict: DistVerdict.stale, rebuilt: true, ok: true })
    expect(builds).toBe(1)

    const second = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: neverBuild })
    expect(second).toEqual({ verdict: DistVerdict.fresh, rebuilt: false, ok: true })
  })

  it('refuses (and does not touch the stamp) when a stale dist fails to rebuild', async () => {
    const { sourceDir, distDir } = tmpProject()
    mkdirSync(distDir, { recursive: true })
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
    writeFileSync(path.join(distDir, STAMP_FILE), JSON.stringify({ fingerprint: 'stale-fingerprint' }))
    const result = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: async () => false })
    expect(result).toEqual({ verdict: DistVerdict.stale, rebuilt: false, ok: false })
    expect(readFileSync(path.join(distDir, STAMP_FILE), 'utf8')).toBe(JSON.stringify({ fingerprint: 'stale-fingerprint' }))
  })

  it('is fresh and never calls build when the stamp already matches the source', async () => {
    const { sourceDir, distDir } = tmpProject()
    mkdirSync(distDir, { recursive: true })
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
    const fingerprint = fingerprintSourceDirs([sourceDir])
    writeFileSync(path.join(distDir, STAMP_FILE), JSON.stringify({ fingerprint }))
    const result = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: neverBuild })
    expect(result).toEqual({ verdict: DistVerdict.fresh, rebuilt: false, ok: true })
  })

  it('goes stale again once the source changes past a fresh stamp', async () => {
    const { sourceDir, distDir } = tmpProject()
    mkdirSync(distDir, { recursive: true })
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
    const fingerprint = fingerprintSourceDirs([sourceDir])
    writeFileSync(path.join(distDir, STAMP_FILE), JSON.stringify({ fingerprint }))
    writeFileSync(path.join(sourceDir, 'main.ts'), 'export const x = 2\n')
    let built = false
    const result = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: async () => { built = true; writeStamp(distDir, fingerprintSourceDirs([sourceDir])); return true } })
    expect(result.verdict).toBe(DistVerdict.stale)
    expect(built).toBe(true)
  })

  it('trusts dist as-is (fresh, no build) when the source tree is entirely absent — a packaged install', async () => {
    const { root, distDir } = tmpProject()
    mkdirSync(distDir, { recursive: true })
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
    const result = await ensureDistFresh({ distDir, sourceDirs: [path.join(root, 'no-such-src')], build: neverBuild })
    expect(result).toEqual({ verdict: DistVerdict.fresh, rebuilt: false, ok: true })
  })

  it('never writes the stamp itself — a build that forgets to leaves dist perpetually stale', async () => {
    const { sourceDir, distDir } = tmpProject()
    const forgetfulBuild = async (): Promise<boolean> => {
      mkdirSync(distDir, { recursive: true })
      writeFileSync(path.join(distDir, 'index.html'), '<html></html>')
      return true
    }
    const first = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: forgetfulBuild })
    expect(first).toEqual({ verdict: DistVerdict.missing, rebuilt: true, ok: true })
    expect(existsSync(path.join(distDir, STAMP_FILE))).toBe(false)

    const second = await ensureDistFresh({ distDir, sourceDirs: [sourceDir], build: forgetfulBuild })
    expect(second.verdict).toBe(DistVerdict.stale)
  })
})

describe('fingerprintSourceDirs — content over mtimes, test files excluded', () => {
  it('does not change when a .test.ts or .spec.ts file is added or edited — they never reach the bundle', () => {
    const { sourceDir } = tmpProject()
    const before = fingerprintSourceDirs([sourceDir])
    writeFileSync(path.join(sourceDir, 'main.test.ts'), 'export const t = 1\n')
    writeFileSync(path.join(sourceDir, 'main.spec.ts'), 'export const s = 1\n')
    expect(fingerprintSourceDirs([sourceDir])).toBe(before)
  })

  it('does change when a shipped file is edited', () => {
    const { sourceDir } = tmpProject()
    const before = fingerprintSourceDirs([sourceDir])
    writeFileSync(path.join(sourceDir, 'main.ts'), 'export const x = 2\n')
    expect(fingerprintSourceDirs([sourceDir])).not.toBe(before)
  })
})
