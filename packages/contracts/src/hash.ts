import { createHash } from 'node:crypto'

// The one content-hash used to fingerprint diffs (commit-tool's preview↔commit handshake) and
// vault-projector's manifest — re-spelled twice as `sha256`/`sha` before this existed.
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
