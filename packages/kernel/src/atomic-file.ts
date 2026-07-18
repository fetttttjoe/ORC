import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The ONE atomic file write for kernel-owned state files (.orc/config.json, .orc/trust.json):
// parent dir ensured, unique tmp name (two concurrent writers never clobber each other's
// temp), rename into place.
export function atomicWriteFileSync(file: string, content: string, opts: { mode?: number } = {}): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, content, { mode: opts.mode })
  renameSync(tmp, file)
}
