import { realpathSync } from 'node:fs'
import path from 'node:path'
import {
  errorMessage, KnowledgeClaim, KNOWLEDGE_LIMITS, KnowledgePatch, KNOWLEDGE_REFUSAL, newKnowledgeId,
  type KnowledgeBackend, type KnowledgeProblem, type KnowledgeWriteResult,
} from '@orc/contracts'
import { cardOf } from '@orc/knowledge-core'
import { bm25 } from './bm25'
import { anchorKind, applyPlan, renderBucket, writeAtomic } from './bucket-files'
import { createBucketLocks, DEFAULT_LOCK_OPTIONS, type LockOptions } from './bucket-lock'
import { createCheckoutIndex, type CheckoutSnapshot, type IndexedBucket } from './checkout-index'
import { codeOf, Errno } from './error-code'
import { freshIdSource } from './fresh-ids'
import { GitFilesOptions } from './options'
import { KNOWLEDGE_PROBLEM } from './problems'
import { generatedClash, locationOf, nameAdditions, planWrite, type KindOf } from './write-plan'

const WRITE_ATTEMPTS = 5

const chunksOf = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

function rootOf(checkout: string): string {
  try { return realpathSync(checkout) } catch (err) {
    if (codeOf(err) === Errno.ENOENT) throw new Error(KNOWLEDGE_REFUSAL.missingCheckout(checkout))
    throw err
  }
}

export interface GitFilesDeps { locks?: LockOptions; newId?: () => string }

export function createGitFilesBackend(input: Record<string, unknown>, deps: GitFilesDeps = {}): KnowledgeBackend {
  const options = GitFilesOptions.parse(input)
  const newId = deps.newId ?? newKnowledgeId
  const index = createCheckoutIndex(options)
  const locks = createBucketLocks(deps.locks ?? DEFAULT_LOCK_OPTIONS)
  const placement = (snapshot: CheckoutSnapshot, kindOf: KindOf) => ({ snapshot, kindOf, dirName: options.dirName })
  const render = (s: CheckoutSnapshot, location: string, claims: readonly KnowledgeClaim[]): string =>
    renderBucket(s, options.dirName, location, claims)

  const needsRewrite = (s: CheckoutSnapshot, bucket: IndexedBucket): boolean =>
    bucket.problems.length === bucket.pending.length
    && (bucket.pending.length > 0 || render(s, bucket.location, bucket.claims) !== bucket.text)

  const rewriteOf = (s: CheckoutSnapshot, bucket: IndexedBucket): string | null => {
    if (!needsRewrite(s, bucket)) return null
    const fresh = freshIdSource(s.claims.keys(), newId)
    const named = bucket.pending.map(draft => KnowledgeClaim.parse({ ...draft, id: fresh(), location: bucket.location }))
    return render(s, bucket.location, [...bucket.claims, ...named])
  }

  const clean = (s: CheckoutSnapshot, location: string): boolean => (s.buckets.get(location)?.problems.length ?? 0) === 0

  const misplaced = (s: CheckoutSnapshot, kindOf: KindOf): KnowledgeClaim[] =>
    [...s.claims.values()].filter(c => {
      try {
        const expected = locationOf(placement(s, kindOf), c.anchors)
        return expected !== c.location && !s.duplicates.has(c.id) && clean(s, c.location) && clean(s, expected)
      } catch { return false }
    })

  const write = async (checkout: string, input: KnowledgePatch): Promise<KnowledgeWriteResult> => {
    const patch = KnowledgePatch.parse(input)
    const root = rootOf(checkout)
    const kindOf = anchorKind(root)
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const s = await index.snapshot(root)
      const additions = nameAdditions(s, patch, newId)
      const planned = planWrite(placement(s, kindOf), patch, additions)
      const result = await locks.withLocks(planned.affected.map(l => path.join(root, l)), async () => {
        const fresh = await index.snapshot(root)
        if (generatedClash(fresh, patch, additions)) return null
        const replanned = planWrite(placement(fresh, kindOf), patch, additions)
        return replanned.affected.join('\n') === planned.affected.join('\n') ? applyPlan(fresh, replanned, root, options.dirName) : null
      })
      if (result !== null) return result
    }
    throw new Error(KNOWLEDGE_REFUSAL.raced())
  }

  const check = async (checkout: string): Promise<KnowledgeProblem[]> => {
    const root = rootOf(checkout)
    const s = await index.snapshot(root)
    const kindOf = anchorKind(root)
    const problems = [...s.problems]
    for (const bucket of s.buckets.values()) {
      for (const claim of bucket.claims) {
        const line = bucket.lines.get(claim.id) ?? 0
        try {
          const expected = locationOf(placement(s, kindOf), claim.anchors)
          if (expected !== bucket.location) problems.push({ location: bucket.location, line, message: KNOWLEDGE_PROBLEM.belongsIn(claim.id, expected) })
        } catch (err) {
          problems.push({ location: bucket.location, line, message: KNOWLEDGE_PROBLEM.badAnchor(claim.id, errorMessage(err)) })
        }
      }
      if (bucket.problems.length === 0 && render(s, bucket.location, bucket.claims) !== bucket.text)
        problems.push({ location: bucket.location, line: 0, message: KNOWLEDGE_PROBLEM.notCanonical() })
    }
    return problems
  }

  return {
    async card(checkout, entity, page) {
      return cardOf(entity, (await index.snapshot(rootOf(checkout))).claims.values(), page)
    },
    async search(checkout, query, limit) {
      const s = await index.snapshot(rootOf(checkout))
      const documents = [...s.claims.values()].map(c => ({
        id: c.id,
        text: [c.text, ...c.tags, ...c.anchors.flatMap(a => (a.symbol === null ? [a.path] : [a.path, a.symbol]))].join(' '),
      }))
      return bm25(documents, query, limit).flatMap(hit => { const claim = s.claims.get(hit.id); return claim ? [claim] : [] })
    },
    async get(checkout, ids) {
      const s = await index.snapshot(rootOf(checkout))
      return ids.flatMap(id => { const claim = s.claims.get(id); return claim ? [claim] : [] })
    },
    write,
    check,
    async format(checkout) {
      const root = rootOf(checkout)
      const s = await index.snapshot(root)
      const formatted = new Set<string>()
      for (const bucket of s.buckets.values()) {
        if (!needsRewrite(s, bucket)) continue
        const file = path.join(root, bucket.location)
        const rewrote = await locks.withLocks([file], async () => {
          const fresh = await index.snapshot(root)
          const held = fresh.buckets.get(bucket.location)
          const text = held === undefined ? null : rewriteOf(fresh, held)
          if (text !== null) writeAtomic(file, text)
          return text !== null
        })
        if (rewrote) formatted.add(bucket.location)
      }
      for (const moves of chunksOf(misplaced(await index.snapshot(root), anchorKind(root)), KNOWLEDGE_LIMITS.patchItems)) {
        const moved = await write(root, KnowledgePatch.parse({ change: moves.map(c => ({ id: c.id })) }))
        for (const c of moves) formatted.add(c.location)
        for (const r of moved.changed) formatted.add(r.location)
      }
      return { formatted: [...formatted].sort(), problems: await check(root) }
    },
  }
}
