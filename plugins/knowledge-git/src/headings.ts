import { ClaimClass } from '@orc/contracts'

export const HEADING_OF_CLASS = { [ClaimClass.fact]: 'Facts', [ClaimClass.why]: 'Why' } as const satisfies Record<ClaimClass, string>
export const HEADINGS: readonly string[] = Object.values(ClaimClass).map(cls => HEADING_OF_CLASS[cls])
export const CLASS_OF_HEADING: Readonly<Record<string, ClaimClass>> =
  Object.fromEntries(Object.values(ClaimClass).map(cls => [HEADING_OF_CLASS[cls], cls]))
