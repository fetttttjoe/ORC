// One allowlisted command string → the argv it spawns with. Pure and zero-import.
//
// Splitting on whitespace made a quoted argument inexpressible: `grep -n "export const X" f.ts`
// spawned grep with `const` and `X"` as FILENAMES, which it reported as missing files. Measured
// live — an agent burned six of thirty iterations rephrasing a valid command, and a later run
// reported grep "non-functional throughout" and left a question unanswered.
//
// This adds QUOTING, not a shell. There is still no pipe, no redirection, no chaining, no glob and
// no substitution: `|`, `;`, `&&`, `$(…)` and `*` remain ordinary characters inside a token, so the
// trust model is unchanged — the operator's allowlist is still matched against the raw string
// before this runs, and the target program still receives inert argv.

/** Quote characters that group; a single quote takes its content literally, as in POSIX. */
const QUOTES = new Set(['"', "'"])

export type ArgvResult = { argv: string[]; error?: undefined } | { argv?: undefined; error: string }

export function commandArgv(command: string): ArgvResult {
  const argv: string[] = []
  let token = ''
  // Tracked separately from `token !== ''` so an EMPTY quoted argument survives: `echo "" tail`
  // must pass two arguments, and whitespace-splitting could not express that at all.
  let started = false
  let quote: string | null = null

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (c === undefined) continue // unreachable (i bounded by command.length above) — satisfies noUncheckedIndexedAccess without `!`
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

  // Refused by NAME rather than guessed at: a half-quoted command is a typo the model can fix in
  // one iteration, where silently splitting it reproduces the very failure this file removes.
  if (quote !== null)
    return { error: `unterminated ${quote === '"' ? 'double' : 'single'} quote — close it, or drop the quotes if the argument has no spaces` }
  if (started) argv.push(token)
  return { argv }
}
