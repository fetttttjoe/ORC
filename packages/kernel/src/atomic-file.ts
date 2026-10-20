import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// unique tmp name per writer, then rename: concurrent writers never clobber each other
export function atomicWriteFileSync(file: string, content: string, opts: { mode?: number } = {}): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, content, { mode: opts.mode })
  renameSync(tmp, file)
}
