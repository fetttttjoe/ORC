import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, type KnowledgeClaim, type KnowledgeRef, type KnowledgeWriteResult } from '@orc/contracts'
import type { CheckoutSnapshot } from './checkout-index'
import { serializeBucket, type SerializableClaim } from './format'
import { HEADING_OF_CLASS, HEADINGS } from './headings'
import { titleOf, type AnchorKind } from './layout'
import { KNOWLEDGE_PROBLEM } from './problems'
import type { Planned } from './write-plan'

const toLine = (c: KnowledgeClaim): SerializableClaim =>
  ({ id: c.id, text: c.text, section: HEADING_OF_CLASS[c.class], anchors: c.anchors, tags: c.tags, sources: c.sources, decision: c.decision })
const ref = (c: KnowledgeClaim): KnowledgeRef => ({ id: c.id, location: c.location })

export const anchorKind = (root: string) => (anchorPath: string): AnchorKind => {
  const absolute = path.resolve(root, anchorPath)
  if (!existsSync(absolute)) throw new Error(KNOWLEDGE_REFUSAL.missingAnchor(anchorPath))
  const real = realpathSync(absolute)
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(KNOWLEDGE_REFUSAL.outsideCheckout(anchorPath))
  return { path: anchorPath, isDirectory: statSync(real).isDirectory() }
}

export function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(temp, content)
    renameSync(temp, file)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function pruneEmpty(dir: string, root: string, dirName: string): void {
  let current = dir
  while (current.startsWith(`${root}${path.sep}`) && existsSync(current) && readdirSync(current).length === 0) {
    rmdirSync(current)
    if (path.basename(current) === dirName) return
    current = path.dirname(current)
  }
}

export const renderBucket = (s: CheckoutSnapshot, dirName: string, location: string, claims: readonly KnowledgeClaim[]): string =>
  serializeBucket(titleOf(location, s.packageRoots, dirName), claims.map(toLine), HEADINGS)

export function applyPlan(s: CheckoutSnapshot, p: Planned, root: string, dirName: string): KnowledgeWriteResult {
  for (const location of p.affected) {
    const problems = s.buckets.get(location)?.problems ?? []
    if (problems.length > 0) throw new Error(KNOWLEDGE_REFUSAL.bucketProblems(location, problems.length))
  }
  const incoming = [...p.added, ...p.changed.map(c => c.after)]
  const dropped = new Set([...incoming.map(c => c.id), ...p.retired.map(c => c.id)])
  const warnings = [...p.warnings]
  const gaining = p.affected.filter(l => incoming.some(c => c.location === l))
  for (const location of [...gaining, ...p.affected.filter(l => !gaining.includes(l))]) {
    const claims = [...(s.buckets.get(location)?.claims ?? []).filter(c => !dropped.has(c.id)), ...incoming.filter(c => c.location === location)]
    const file = path.join(root, location)
    if (claims.length === 0) {
      rmSync(file, { force: true })
      pruneEmpty(path.dirname(file), root, dirName)
      continue
    }
    writeAtomic(file, renderBucket(s, dirName, location, claims))
    if (claims.length > KNOWLEDGE_LIMITS.bucketWarnClaims) warnings.push(KNOWLEDGE_PROBLEM.crowded(location, claims.length))
  }
  return { added: p.added.map(ref), changed: p.changed.map(c => ref(c.after)), retired: p.retired.map(ref), warnings, files: [...p.affected] }
}
