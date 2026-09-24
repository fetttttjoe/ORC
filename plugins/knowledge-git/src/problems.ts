export const FMT_HINT = 'run orc knowledge fmt'

export const KNOWLEDGE_PROBLEM = {
  missingId: (): string => `missing id — ${FMT_HINT}`,
  notCanonical: (): string => `not in canonical form — ${FMT_HINT}`,
  alsoIn: (id: string, other: string): string => `id '${id}' is also in '${other}'`,
  belongsIn: (id: string, expected: string): string => `${id} belongs in '${expected}'`,
  badAnchor: (id: string, reason: string): string => `${id}: ${reason}`,
  crowded: (location: string, count: number): string => `'${location}' holds ${count} claims — the code it describes may do too much`,
} as const
