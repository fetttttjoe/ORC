import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateOutputPaths } from '@orc/contracts'

export interface ArtifactReceipt {
  path: string // canonical workspace-relative
  sha256: string
  size: number
}

// The canonical receipt is derived by trusted code — never supplied by the agent.
// Path rules (containment, regular file, no duplicates) live in validateOutputPaths,
// shared with the executor's pre-flight; this adds only the hashing.
export function verifyArtifacts(workspaceDir: string, paths: string[]): ArtifactReceipt[] {
  return validateOutputPaths(workspaceDir, paths).map(({ path, abs }) => {
    const bytes = readFileSync(abs)
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength }
  })
}
