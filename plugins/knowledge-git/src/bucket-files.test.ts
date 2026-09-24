import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeAtomic } from './bucket-files'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('writeAtomic', () => {
  it('removes its temp file when the rename fails, and rethrows', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-katomic-')))
    dirs.push(dir)
    const target = path.join(dir, 'bucket.md')
    mkdirSync(path.join(target, 'held'), { recursive: true })
    expect(() => writeAtomic(target, 'text')).toThrow('EISDIR')
    expect(readdirSync(dir)).toEqual(['bucket.md'])
  })
})
