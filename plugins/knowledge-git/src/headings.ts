import { AdrSection, ClaimClass } from '@orc/contracts'
import type { DecisionHeadings } from './decision-format'

export const HEADING_OF_CLASS = { [ClaimClass.fact]: 'Facts', [ClaimClass.why]: 'Why' } as const satisfies Record<ClaimClass, string>
export const HEADINGS: readonly string[] = Object.values(ClaimClass).map(cls => HEADING_OF_CLASS[cls])
export const CLASS_OF_HEADING: Readonly<Record<string, ClaimClass>> =
  Object.fromEntries(Object.values(ClaimClass).map(cls => [HEADING_OF_CLASS[cls], cls]))
export const DECISION_HEADINGS: DecisionHeadings = {
  context: AdrSection.context, decision: AdrSection.decision, consequences: AdrSection.consequences, considered: AdrSection.considered,
}
