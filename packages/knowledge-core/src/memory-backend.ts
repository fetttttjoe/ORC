import {
  KNOWLEDGE_REFUSAL, KnowledgeClaim, newKnowledgeId, ROOT_ENTITY,
  type Decision, type DecisionDraft, type KnowledgeAnchor, type KnowledgeBackend, type KnowledgeDraft, type KnowledgeRef,
} from '@orc/contracts'
import { cardOf } from './card'
import { planDecisionRecord } from './decision-record'
import { mergeChange, refuseUnknownDecision, sameContent } from './patch'

export interface MemoryBackendOptions { exists: (checkout: string, path: string) => boolean }

const MEMORY_LOCATION = 'memory:'
const DECISION_LOCATION = `${MEMORY_LOCATION}decision/`

const perCheckout = <V>() => {
  const maps = new Map<string, Map<string, V>>()
  return (checkout: string): Map<string, V> => {
    const held = maps.get(checkout)
    if (held) return held
    const made = new Map<string, V>()
    maps.set(checkout, made)
    return made
  }
}

export function createMemoryBackend(options: MemoryBackendOptions): KnowledgeBackend {
  const storeOf = perCheckout<KnowledgeClaim>()
  const decisionsOf = perCheckout<Decision>()
  const decisionLocationOf = (draft: DecisionDraft): string => `${DECISION_LOCATION}${draft.id}`
  const locationOf = (anchors: readonly KnowledgeAnchor[]): string => `${MEMORY_LOCATION}${anchors[0]?.path ?? ROOT_ENTITY}`
  const freshId = (store: Map<string, KnowledgeClaim>): string => {
    for (;;) { const id = newKnowledgeId(); if (!store.has(id)) return id }
  }
  const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w !== '')

  return {
    async card(checkout, entity, page) { return cardOf(entity, storeOf(checkout).values(), page) },
    async search(checkout, query, limit) {
      const wanted = words(query)
      if (wanted.length === 0) return []
      return [...storeOf(checkout).values()]
        .filter(c => { const have = new Set(words([c.text, ...c.tags].join(' '))); return wanted.every(w => have.has(w)) })
        .slice(0, limit)
    },
    async get(checkout, ids) {
      const store = storeOf(checkout)
      return ids.flatMap(id => { const held = store.get(id); return held ? [held] : [] })
    },
    async write(checkout, patch) {
      const store = storeOf(checkout)
      refuseUnknownDecision(patch, () => decisionsOf(checkout))
      const place = (draft: KnowledgeDraft, id: string): KnowledgeClaim => {
        for (const anchor of draft.anchors) if (!options.exists(checkout, anchor.path)) throw new Error(KNOWLEDGE_REFUSAL.missingAnchor(anchor.path))
        return KnowledgeClaim.parse({ ...draft, id, location: locationOf(draft.anchors) })
      }
      const added = patch.add.map(a => place(a, a.id ?? freshId(store)))
      for (const claim of added) {
        const held = store.get(claim.id)
        if (held && !sameContent(held, claim)) throw new Error(KNOWLEDGE_REFUSAL.idClash(claim.id))
      }
      const changed = patch.change.map(c => {
        const held = store.get(c.id)
        if (!held) throw new Error(KNOWLEDGE_REFUSAL.unknownId(c.id))
        return place(mergeChange(held, c), c.id)
      })
      const warnings: string[] = []
      const retired: KnowledgeRef[] = []
      for (const id of patch.retire) {
        const held = store.get(id)
        if (!held) { warnings.push(KNOWLEDGE_REFUSAL.notRetired(id)); continue }
        store.delete(id)
        retired.push({ id, location: held.location })
      }
      for (const claim of [...added, ...changed]) store.set(claim.id, claim)
      const ref = (c: KnowledgeClaim): KnowledgeRef => ({ id: c.id, location: c.location })
      return { added: added.map(ref), changed: changed.map(ref), retired, warnings, files: [] }
    },
    async check() { return [] },
    async format() { return { formatted: [], problems: [] } },
    async decisions(checkout) { return [...decisionsOf(checkout).values()] },
    async decision(checkout, id) { return decisionsOf(checkout).get(id) ?? null },
    async recordDecision(checkout, draft) {
      const held = decisionsOf(checkout)
      const plan = planDecisionRecord({ held, claimed: new Set(held.keys()), draft, locationOf: decisionLocationOf })
      for (const decision of plan.writes) held.set(decision.id, decision)
      return { ...plan.result, files: [] }
    },
  }
}
