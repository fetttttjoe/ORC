import path from 'node:path'
import { type DistFreshnessResult, ensureDistFresh, fingerprintSourceDirs, writeStamp } from './dist-freshness'

// keep in sync with the workspace packages web/src imports by source (no other vite aliases)
export function graphUiDistPaths(): { webDir: string; distDir: string; sourceDirs: string[] } {
  const webDir = path.resolve(import.meta.dir, '../web')
  return {
    webDir,
    distDir: path.join(webDir, 'dist'),
    sourceDirs: [
      path.join(webDir, 'src'),
      path.resolve(import.meta.dir, '../../ui-core/src'),
      path.resolve(import.meta.dir, '../../contracts/src'),
    ],
  }
}

// called by stamp-dist.ts, which web's `build` script runs right after `vite build`
export function stampGraphUiDist(): void {
  const { distDir, sourceDirs } = graphUiDistPaths()
  writeStamp(distDir, fingerprintSourceDirs(sourceDirs))
}

function defaultBuild(webDir: string): () => Promise<boolean> {
  return async () => {
    const proc = Bun.spawn(['bun', 'run', 'build'], { cwd: webDir, stdout: 'inherit', stderr: 'inherit' })
    const code = await proc.exited
    return code === 0
  }
}

export interface GraphUiDistFreshnessResult extends DistFreshnessResult {
  // absolute: `orc graph` runs with the CWD of whatever project it serves, not this checkout
  manualBuildCommand: string
}

export async function ensureGraphUiDistFresh(): Promise<GraphUiDistFreshnessResult> {
  const { webDir, distDir, sourceDirs } = graphUiDistPaths()
  const result = await ensureDistFresh({ distDir, sourceDirs, build: defaultBuild(webDir) })
  return { ...result, manualBuildCommand: `cd ${webDir} && bun run build` }
}
