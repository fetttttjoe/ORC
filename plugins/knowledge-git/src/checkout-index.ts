import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { KnowledgeClaim, KnowledgeDraft, normalizeEntity, type KnowledgeProblem } from '@orc/contracts'
import { codeOf } from './error-code'
import { parseBucket } from './format'
import { CLASS_OF_HEADING, HEADINGS } from './headings'
import { isBucket } from './layout'
import type { GitFilesOptions } from './options'
import { KNOWLEDGE_PROBLEM } from './problems'

export interface IndexedBucket {
  location: string
  text: string
  claims: KnowledgeClaim[]
  lines: ReadonlyMap<string, number>
  pending: KnowledgeDraft[]
  problems: KnowledgeProblem[]
}
export interface CheckoutSnapshot {
  packageRoots: string[]
  buckets: ReadonlyMap<string, IndexedBucket>
  claims: ReadonlyMap<string, KnowledgeClaim>
  duplicates: ReadonlySet<string>
  problems: KnowledgeProblem[]
}

async function lsFiles(checkout: string, pathspecs: readonly string[]): Promise<string[]> {
  const proc = Bun.spawn(['git', '-C', checkout, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`the git-files backend needs a git checkout — git ls-files failed in ${checkout}: ${err.trim()}`)
  return [...new Set(out.split('\0').filter(p => p !== ''))].sort()
}

function readIfPresent(file: string): string | null {
  try { return readFileSync(file, 'utf8') } catch (err) {
    if (codeOf(err) === 'ENOENT') return null
    throw err
  }
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

function toBucket(location: string, text: string): IndexedBucket {
  const parsed = parseBucket(text, HEADINGS)
  const problems: KnowledgeProblem[] = parsed.problems.map(p => ({ location, line: p.line, message: p.message }))
  const claims: KnowledgeClaim[] = []
  const lines = new Map<string, number>()
  const pending: KnowledgeDraft[] = []
  for (const line of parsed.claims) {
    const fields = { text: line.text, class: CLASS_OF_HEADING[line.section], anchors: line.anchors, tags: line.tags, sources: line.sources, decision: line.decision }
    if (line.id === null) {
      const draft = KnowledgeDraft.safeParse(fields)
      if (draft.success) pending.push(draft.data)
      problems.push({ location, line: line.line, message: draft.success ? KNOWLEDGE_PROBLEM.missingId() : draft.error.issues.map(i => i.message).join('; ') })
      continue
    }
    const claim = KnowledgeClaim.safeParse({ ...fields, id: line.id, location })
    if (!claim.success) { problems.push({ location, line: line.line, message: claim.error.issues.map(i => i.message).join('; ') }); continue }
    claims.push(claim.data)
    lines.set(claim.data.id, line.line)
  }
  return { location, text, claims, lines, pending, problems }
}

export function createCheckoutIndex(options: GitFilesOptions) {
  const cache = new Map<string, Map<string, { hash: string; bucket: IndexedBucket }>>()
  return {
    async snapshot(checkout: string): Promise<CheckoutSnapshot> {
      const [candidates, manifests] = await Promise.all([
        lsFiles(checkout, [`:(glob)**/${options.dirName}/**/*.md`]),
        lsFiles(checkout, options.manifests.map(m => `:(glob)**/${m}`)),
      ])
      const packageRoots = [...new Set(manifests.filter(m => existsSync(path.join(checkout, m))).map(m => normalizeEntity(path.posix.dirname(m))))]
      const held = cache.get(checkout) ?? new Map<string, { hash: string; bucket: IndexedBucket }>()
      const next = new Map<string, { hash: string; bucket: IndexedBucket }>()
      const buckets = new Map<string, IndexedBucket>()
      for (const location of candidates.filter(c => isBucket(c, packageRoots, options.dirName))) {
        const text = readIfPresent(path.join(checkout, location))
        if (text === null) continue
        const hash = hashOf(text)
        const hit = held.get(location)
        const bucket = hit !== undefined && hit.hash === hash ? hit.bucket : toBucket(location, text)
        next.set(location, { hash, bucket })
        buckets.set(location, bucket)
      }
      cache.set(checkout, next)
      const claims = new Map<string, KnowledgeClaim>()
      const duplicates = new Set<string>()
      const problems: KnowledgeProblem[] = []
      for (const bucket of buckets.values()) {
        problems.push(...bucket.problems)
        for (const claim of bucket.claims) {
          const first = claims.get(claim.id)
          if (first === undefined) { claims.set(claim.id, claim); continue }
          duplicates.add(claim.id)
          problems.push({ location: bucket.location, line: bucket.lines.get(claim.id) ?? 0, message: KNOWLEDGE_PROBLEM.alsoIn(claim.id, first.location) })
        }
      }
      return { packageRoots, buckets, claims, duplicates, problems }
    },
  }
}
