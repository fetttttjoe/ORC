import { DecisionStatus } from '@orc/contracts'
import { DECISION_FILE_SUFFIX, FrontKey } from './decision-format'

export const FMT_HINT = 'run orc knowledge fmt'
const NO_DECISION = 'which is no decision in this checkout'

export const KNOWLEDGE_PROBLEM = {
  missingId: (): string => `missing id — ${FMT_HINT}`,
  notCanonical: (): string => `not in canonical form — ${FMT_HINT}`,
  alsoIn: (id: string, other: string): string => `id '${id}' is also in '${other}'`,
  belongsIn: (id: string, expected: string): string => `${id} belongs in '${expected}'`,
  badAnchor: (id: string, reason: string): string => `${id}: ${reason}`,
  crowded: (location: string, count: number): string => `'${location}' holds ${count} claims — the code it describes may do too much`,
  unknownDecision: (id: string, slug: string): string => `${id} names decision '${slug}', ${NO_DECISION}`,
} as const

export const DECISION_PROBLEM = {
  badName: (name: string): string => `'${name}' is not a decision file name — expected <yyyy-mm-dd>-<slug>${DECISION_FILE_SUFFIX}`,
  duplicate: (id: string, others: readonly string[]): string => `decision id '${id}' is also in ${others.map(o => `'${o}'`).join(', ')} — neither is read`,
  danglingSupersedes: (id: string, slug: string): string => `${id} has ${FrontKey.supersedes} '${slug}', ${NO_DECISION}`,
  danglingSupersededBy: (id: string, slug: string): string => `${id} has ${FrontKey.supersededBy} '${slug}', ${NO_DECISION}`,
  notReciprocal: (newer: string, older: string): string =>
    `'${newer}' supersedes '${older}' on one side only — '${newer}' needs ${FrontKey.supersedes}: ${older}; '${older}' needs `
    + `${FrontKey.status}: ${DecisionStatus.superseded} and ${FrontKey.supersededBy}: ${newer}`,
  statusMismatch: (id: string): string =>
    `${id}: ${FrontKey.status}: ${DecisionStatus.superseded} and ${FrontKey.supersededBy} go together — one is set without the other`,
} as const
