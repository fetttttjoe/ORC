import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CONTRACT_FILES } from '@orc/knowledge-core/contract-suite'

export const gitCheckout = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-kgit-')))
  Bun.spawnSync(['git', 'init', '-q', dir])
  for (const file of CONTRACT_FILES) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), file.endsWith('package.json') ? '{}\n' : '')
  }
  return dir
}
