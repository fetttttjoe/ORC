import { InvalidArgumentError } from 'commander'

// ONE spelling of "reject a value outside a closed vocabulary, naming the set"; `.find` returns the
// MEMBER type, so this needs neither a cast nor a second parse. Not in main.ts: the command modules
// main.ts imports use it too, and that would be a cycle.
export function enumArg<T extends string>(label: string, valid: readonly T[]): (value: string) => T {
  return (value: string): T => {
    const hit = valid.find(v => v === value)
    if (hit === undefined)
      throw new InvalidArgumentError(`unknown ${label} '${value}' — valid: ${valid.join(', ')}`)
    return hit
  }
}
