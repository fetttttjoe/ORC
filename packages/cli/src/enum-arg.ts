import { InvalidArgumentError } from 'commander'

// `.find` returns the member type, so no cast or second parse; not in main.ts, which would cycle
export function enumArg<T extends string>(label: string, valid: readonly T[]): (value: string) => T {
  return (value: string): T => {
    const hit = valid.find(v => v === value)
    if (hit === undefined)
      throw new InvalidArgumentError(`unknown ${label} '${value}' — valid: ${valid.join(', ')}`)
    return hit
  }
}
