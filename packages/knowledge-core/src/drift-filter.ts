import { underEntity, type DriftFilter, type KnowledgeClaim } from '@orc/contracts'

const related = (a: string, b: string): boolean => underEntity(a, b) || underEntity(b, a)

export const matchesDrift = (filter: DriftFilter, claim: KnowledgeClaim): boolean =>
  (filter.ids === undefined || filter.ids.includes(claim.id))
  && (filter.paths === undefined || filter.paths.some(p => claim.anchors.some(a => related(p, a.path))))
