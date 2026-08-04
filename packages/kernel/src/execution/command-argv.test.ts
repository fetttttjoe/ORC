import { describe, expect, it } from 'bun:test'
import { commandArgv } from './command-argv'

const argv = (s: string): string[] | undefined => commandArgv(s).argv

describe('commandArgv (quoting, but still no shell)', () => {
  it('splits on whitespace and collapses runs of it', () => {
    expect(argv('bun  test   packages/x')).toEqual(['bun', 'test', 'packages/x'])
    expect(argv('  leading and trailing  ')).toEqual(['leading', 'and', 'trailing'])
  })

  it('groups a quoted run into one token, both quote styles', () => {
    expect(argv('grep -n "export const X" f.ts')).toEqual(['grep', '-n', 'export const X', 'f.ts'])
    expect(argv("grep -n 'a b c' f.ts")).toEqual(['grep', '-n', 'a b c', 'f.ts'])
  })

  it('keeps an empty quoted argument, which whitespace-splitting could not express', () => {
    expect(argv('echo "" tail')).toEqual(['echo', '', 'tail'])
  })

  it('joins quoted and bare halves into a single token, as a shell would', () => {
    expect(argv('git log --format="%h %s"')).toEqual(['git', 'log', '--format=%h %s'])
  })

  it('escapes with a backslash outside quotes and inside DOUBLE quotes only', () => {
    expect(argv('grep a\\ b f.ts')).toEqual(['grep', 'a b', 'f.ts'])
    expect(argv('grep "say \\"hi\\"" f.ts')).toEqual(['grep', 'say "hi"', 'f.ts'])
    // single quotes are literal — a backslash inside them is a backslash
    expect(argv("grep 'a\\b' f.ts")).toEqual(['grep', 'a\\b', 'f.ts'])
  })

  /**
   * The trust model is unchanged: this adds grouping, NOT interpretation. Every metacharacter stays
   * an ordinary character in an argv token, so the target program rejects it rather than a shell
   * acting on it — the property the exec tool has always relied on.
   */
  it('leaves every shell metacharacter inert inside its token', () => {
    expect(argv('echo hi; rm -rf /')).toEqual(['echo', 'hi;', 'rm', '-rf', '/'])
    expect(argv('echo a | tee b')).toEqual(['echo', 'a', '|', 'tee', 'b'])
    expect(argv('echo $(whoami) *.ts && ls')).toEqual(['echo', '$(whoami)', '*.ts', '&&', 'ls'])
  })

  it('refuses an unterminated quote by name instead of guessing a split', () => {
    const r = commandArgv('grep -n "unclosed f.ts')
    expect(r.argv).toBeUndefined()
    expect(r.error).toContain('unterminated double quote')
    expect(commandArgv("grep 'unclosed").error).toContain('unterminated single quote')
  })

  it('is empty for an empty command rather than yielding a blank token', () => {
    expect(argv('')).toEqual([])
    expect(argv('   ')).toEqual([])
  })
})
