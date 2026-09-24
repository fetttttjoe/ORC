import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describeKnowledgeBackend } from '@orc/knowledge-core/contract-suite'
import { createGitFilesBackend } from './backend'
import { gitCheckout } from './test-helpers'

describeKnowledgeBackend('the git-files backend', async () => {
  const lockDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-klock-')))
  const checkout = gitCheckout()
  const other = gitCheckout()
  return {
    backend: createGitFilesBackend({}, { locks: { staleMs: 30_000, retryMs: 5, timeoutMs: 10_000, dir: lockDir } }),
    checkout, other,
    cleanup: async () => { for (const d of [checkout, other, lockDir]) rmSync(d, { recursive: true, force: true }) },
  }
})
