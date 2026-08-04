import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * A raw NUL byte in a source file makes it BINARY to grep and ripgrep: every search over that file
 * silently returns nothing, while it looks perfectly normal in an editor. That is how three of them
 * survived a commit in `exec-tool.ts`, and then a fourth in the very file written to fix those —
 * a unicode escape typed into a template literal can land as a literal byte instead.
 *
 * Scoped to non-test sources on purpose. Two test files carry NULs deliberately: they assert on
 * real noteKey/edgeKey strings, where the byte IS the separator, and rewriting correct tests to
 * satisfy a lint would be the tail wagging the dog. When a SOURCE file needs that value at runtime,
 * encode the parts (JSON.stringify) rather than embedding the character — see tree-fingerprint.ts.
 */
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
