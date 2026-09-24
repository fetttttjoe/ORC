import { normalizeEntity, ROOT_ENTITY, underEntity, type KnowledgeCard, type KnowledgeClaim, type KnowledgePage } from '@orc/contracts'

const OFFSET = /^\d+$/
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const CARD_REFUSAL = {
  cursor: (cursor: string): string => `cursor '${cursor}' was not handed out by a card — start again without one`,
} as const

export function cardOf(entity: string, claims: Iterable<KnowledgeClaim>, page: KnowledgePage): KnowledgeCard {
  const own = normalizeEntity(entity)
  if (page.cursor !== null && !OFFSET.test(page.cursor)) throw new Error(CARD_REFUSAL.cursor(page.cursor))
  const members = [...claims]
    .filter(c => own === ROOT_ENTITY || c.anchors.some(a => underEntity(own, a.path)))
    .sort((a, b) => byCodeUnit(a.location, b.location) || byCodeUnit(a.id, b.id))
  const offset = page.cursor === null ? 0 : Number(page.cursor)
  const slice = members.slice(offset, offset + page.limit)
  const end = offset + slice.length
  return { entity: own, claims: slice, next: end < members.length ? String(end) : null }
}
