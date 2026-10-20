import { createHash } from 'node:crypto'

// fingerprints diffs (commit-tool handshake) and the vault-projector manifest
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
