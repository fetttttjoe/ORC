import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { decideDistVerdict, DistVerdict } from './dist-verdict'

export const STAMP_FILE = 'orc-build-stamp.json'
const INDEX_FILE = 'index.html'
const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', '.svelte-kit'])
// never reach the bundle, so a test edit must not force a rebuild
const SKIPPED_FILE_RE = /\.(test|spec)\.ts$/

const Stamp = z.object({ fingerprint: z.string().min(1) })

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue
    if (entry.isFile() && SKIPPED_FILE_RE.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

// content, not mtimes — a checkout rewrites mtimes without changing bytes
export function fingerprintSourceDirs(dirs: readonly string[]): string {
  const files: string[] = []
  for (const dir of dirs) if (existsSync(dir)) collectFiles(dir, files)
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function readStamp(distDir: string): string | null {
  const stampPath = path.join(distDir, STAMP_FILE)
  if (!existsSync(stampPath)) return null
  try {
    const parsed = Stamp.safeParse(JSON.parse(readFileSync(stampPath, 'utf8')))
    return parsed.success ? parsed.data.fingerprint : null
  } catch {
    return null
  }
}

// the one writer of the stamp — a build calls this, ensureDistFresh never does
export function writeStamp(distDir: string, fingerprint: string): void {
  const stamp: z.infer<typeof Stamp> = { fingerprint }
  writeFileSync(path.join(distDir, STAMP_FILE), JSON.stringify(stamp))
}

export interface DistFreshnessConfig {
  distDir: string
  sourceDirs: readonly string[]
  // must call writeStamp on distDir before resolving true
  build: () => Promise<boolean>
}

export interface DistFreshnessResult {
  verdict: DistVerdict
  rebuilt: boolean
  // false: dist is missing or stale and rebuilding did not fix it — refuse to serve it
  ok: boolean
}

export async function ensureDistFresh(cfg: DistFreshnessConfig): Promise<DistFreshnessResult> {
  const distExists = existsSync(path.join(cfg.distDir, INDEX_FILE))
  const sourceAvailable = cfg.sourceDirs.some(existsSync)
  const sourceFingerprint = sourceAvailable ? fingerprintSourceDirs(cfg.sourceDirs) : ''
  const stamp = distExists ? readStamp(cfg.distDir) : null
  const verdict = decideDistVerdict({ distExists, sourceAvailable, stamp, sourceFingerprint })
  if (verdict === DistVerdict.fresh) return { verdict, rebuilt: false, ok: true }
  const built = await cfg.build()
  return built ? { verdict, rebuilt: true, ok: true } : { verdict, rebuilt: false, ok: false }
}
