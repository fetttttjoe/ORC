import { InvalidArgumentError } from 'commander'

// ONE spelling of "reject a value outside a closed vocabulary, naming the set" — the alternative is
// a typo silently filtering everything out and reading as "this lane is empty". Three call sites had
// grown their own version of it (the tier lane, `neighbors --kinds`, and now `memory add --kind`),
// each with a different error shape for the identical mistake, and the --kinds one additionally
// re-parsed the value through zod afterwards purely to avoid a cast.
// `.find` returns the MEMBER type, so this needs neither a cast nor a second parse.
//
// Its own file rather than main.ts's: adr-commands.ts parses `--status` through it, and main.ts
// imports adr-commands.ts to register the command — so leaving it in main.ts would make the two
// modules a cycle for the sake of eight lines.
export function enumArg<T extends string>(label: string, valid: readonly T[]): (value: string) => T {
  return (value: string): T => {
    const hit = valid.find(v => v === value)
    if (hit === undefined)
      throw new InvalidArgumentError(`unknown ${label} '${value}' — valid: ${valid.join(', ')}`)
    return hit
  }
}
