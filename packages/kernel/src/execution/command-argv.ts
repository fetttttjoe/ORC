// One allowlisted command string → argv. Quoting, not a shell: |, ;, && and $(…) stay literal.

const QUOTES = new Set(['"', "'"])

export type ArgvResult = { argv: string[]; error?: undefined } | { argv?: undefined; error: string }

export function commandArgv(command: string): ArgvResult {
  const argv: string[] = []
  let token = ''
  // Separate from token !== '' so an empty quoted argument survives.
  let started = false
  let quote: string | null = null

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (c === undefined) continue // unreachable; satisfies noUncheckedIndexedAccess
    if (quote !== null) {
      // a backslash escapes inside DOUBLE quotes only — single quotes are literal, as in POSIX
      if (c === '\\' && quote === '"' && i + 1 < command.length) { token += command[++i]; continue }
      if (c === quote) { quote = null; continue }
      token += c
      continue
    }
    if (QUOTES.has(c)) { quote = c; started = true; continue }
    if (c === '\\' && i + 1 < command.length) { token += command[++i]; started = true; continue }
    if (/\s/.test(c)) {
      if (started) { argv.push(token); token = ''; started = false }
      continue
    }
    token += c
    started = true
  }

  // A half-quoted command is refused by name: silently splitting it would repeat the old failure.
  if (quote !== null)
    return { error: `unterminated ${quote === '"' ? 'double' : 'single'} quote — close it, or drop the quotes if the argument has no spaces` }
  if (started) argv.push(token)
  return { argv }
}
