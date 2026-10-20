import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/** A raw NUL byte makes a file BINARY to grep, so searches over it silently return nothing */
describe('source files stay searchable', () => {
  it('no non-test TypeScript or Svelte source contains a raw NUL byte', async () => {
    const tracked = (await Bun.$`git ls-files '*.ts' '*.svelte'`.text())
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.includes('.test.') && !l.endsWith('.d.ts'))

    // NUL only: tab, newline and CR are ordinary in source and must not be flagged
    const offenders = tracked.filter(f => readFileSync(f).includes(0))

    expect(
      offenders,
      `binary to grep — encode the value instead of embedding the byte:\n${offenders.join('\n')}`,
    ).toEqual([])
  }, 30_000)
})
