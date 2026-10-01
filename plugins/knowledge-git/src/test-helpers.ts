import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTreeSitterStructure } from '@orc/structure-treesitter'
import { CONTRACT_FILES, contractSourceOf } from '@orc/knowledge-core/contract-suite'

export const structure = createTreeSitterStructure()

export const git = (dir: string, ...args: string[]): void => {
  const run = Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args])
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
}

export const commitPaths = (dir: string, message: string, paths: readonly string[]): void => {
  git(dir, 'add', '--', ...paths)
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
}

export const commitAll = (dir: string, message = 'basis'): void => commitPaths(dir, message, ['.'])

export const gitCheckout = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-kgit-')))
  Bun.spawnSync(['git', 'init', '-q', dir])
  for (const file of CONTRACT_FILES) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), contractSourceOf(file))
  }
  return dir
}
