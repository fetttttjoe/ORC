import {
  KNOWLEDGE_REFUSAL, KnowledgeClaim, newKnowledgeId, ROOT_ENTITY,
  type Decision, type DecisionDraft, type KnowledgeAnchor, type KnowledgeBackend, type KnowledgeDraft, type KnowledgeRef,
  type StructureProvider,
} from '@orc/contracts'
import { digestIn, directoryDigest, GONE, readingOf, sourceView, UNREADABLE, type AnchorDigest } from './anchor-digest'
import { cardOf } from './card'
import { planDecisionRecord } from './decision-record'
import { matchesDrift } from './drift-filter'
import { mergeChange, refuseUnknownDecision, sameContent } from './patch'
import { canonicalizePatch } from './symbol-anchors'

export interface InMemoryBackendOptions {
  exists: (checkout: string, path: string) => boolean
  structure: StructureProvider
  read: (checkout: string, path: string) => string | null
}

export const NO_STRUCTURE: StructureProvider = { outline: async () => null }

const MEMORY_LOCATION = 'memory:'
const DECISION_LOCATION = `${MEMORY_LOCATION}decision/`
const WRITE_BASIS = `${MEMORY_LOCATION}write/`
const DIRECTORY_PRESENT: AnchorDigest = { digest: directoryDigest([]), readable: true }

type AnchorSnapshot = { present: false } | { present: true; source: string | null }
interface Basis { label: string; anchors: AnchorSnapshot[] }

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

export function createInMemoryBackend(options: InMemoryBackendOptions): KnowledgeBackend {
  const storeOf = perCheckout<KnowledgeClaim>()
  const basesOf = perCheckout<Basis>()
  const decisionsOf = perCheckout<Decision>()
  let writes = 0
  const decisionLocationOf = (draft: DecisionDraft): string => `${DECISION_LOCATION}${draft.id}`
  const locationOf = (anchors: readonly KnowledgeAnchor[]): string => `${MEMORY_LOCATION}${anchors[0]?.path ?? ROOT_ENTITY}`
  const freshId = (store: Map<string, KnowledgeClaim>): string => {
    for (;;) { const id = newKnowledgeId(); if (!store.has(id)) return id }
  }
  const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w !== '')
  const snapshot = (checkout: string, path: string): AnchorSnapshot =>
    options.exists(checkout, path) ? { present: true, source: options.read(checkout, path) } : { present: false }
  const digestOf = async (at: AnchorSnapshot | undefined, anchor: KnowledgeAnchor): Promise<AnchorDigest> => {
    if (at === undefined || !at.present) return GONE
    if (at.source === null) return anchor.symbol === null ? DIRECTORY_PRESENT : UNREADABLE
    return digestIn(sourceView(Buffer.from(at.source, 'utf8'), await options.structure.outline(at.source, anchor.path)), anchor.symbol)
  }

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
    async write(checkout, input) {
      const store = storeOf(checkout)
      refuseUnknownDecision(input, () => decisionsOf(checkout))
      const place = (draft: KnowledgeDraft, id: string): KnowledgeClaim => {
        for (const anchor of draft.anchors) if (!options.exists(checkout, anchor.path)) throw new Error(KNOWLEDGE_REFUSAL.missingAnchor(anchor.path))
        return KnowledgeClaim.parse({ ...draft, id, location: locationOf(draft.anchors) })
      }
      const patch = await canonicalizePatch(input, async anchorPath => {
        if (!options.exists(checkout, anchorPath)) throw new Error(KNOWLEDGE_REFUSAL.missingAnchor(anchorPath))
        const source = options.read(checkout, anchorPath)
        return source === null ? null : options.structure.outline(source, anchorPath)
      })
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
      const bases = basesOf(checkout)
      for (const id of patch.retire) {
        const held = store.get(id)
        if (!held) { warnings.push(KNOWLEDGE_REFUSAL.notRetired(id)); continue }
        store.delete(id)
        bases.delete(id)
        retired.push({ id, location: held.location })
      }
      const label = `${WRITE_BASIS}${++writes}`
      for (const claim of [...added.filter(c => !store.has(c.id)), ...changed])
        bases.set(claim.id, { label, anchors: claim.anchors.map(a => snapshot(checkout, a.path)) })
      for (const claim of [...added, ...changed]) store.set(claim.id, claim)
      const ref = (c: KnowledgeClaim): KnowledgeRef => ({ id: c.id, location: c.location })
      return { added: added.map(ref), changed: changed.map(ref), retired, warnings, files: [] }
    },
    async check() { return [] },
    async readings(checkout, filter) {
      const bases = basesOf(checkout)
      return Promise.all([...storeOf(checkout).values()].filter(c => matchesDrift(filter, c)).map(async claim => {
        const basis = bases.get(claim.id)
        const anchors = await Promise.all(claim.anchors.map(async (anchor, i) =>
          readingOf(anchor, await digestOf(basis?.anchors[i], anchor), await digestOf(snapshot(checkout, anchor.path), anchor))))
        return { claim, basis: basis?.label ?? null, anchors }
      }))
    },
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
