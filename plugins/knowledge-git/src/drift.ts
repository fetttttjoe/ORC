import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { normalizeEntity, type ClaimReading, type KnowledgeAnchor, type KnowledgeClaim } from '@orc/contracts'
import { digestIn, directoryDigest, GONE, readingOf, sourceView, textOf, UNREADABLE, type AnchorDigest, type SourceView } from '@orc/knowledge-core'
import { readBytes } from './anchor-symbols'
import { codeOf, Errno } from './error-code'
import { claimIdOf } from './format'
import type { SourceOutline } from './outline-cache'

export type GitRun = (root: string, args: readonly string[], stdin?: string) => Promise<Uint8Array>

export const DRIFT_REFUSAL = {
  git: (command: string, root: string, stderr: string): string => `git ${command} failed in ${root}: ${stderr}`,
  unreadable: (line: string): string => `git cat-file --batch-check answered '${line}', neither an object nor missing`,
} as const

export const runGit: GitRun = async (root, args, stdin) => {
  const proc = Bun.spawn(['git', '--literal-pathspecs', '-c', 'core.quotePath=false', '-C', root, ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(DRIFT_REFUSAL.git(args[0] ?? '', root, err.trim()))
  return new Uint8Array(out)
}

const gitText = async (git: GitRun, root: string, args: readonly string[], stdin?: string): Promise<string> => textOf(await git(root, args, stdin))

enum ObjectType { blob = 'blob', tree = 'tree', commit = 'commit', tag = 'tag' }
interface GitObject { oid: string; type: ObjectType }

const OBJECT_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+)$/
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/
const BLAME_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+(?: \d+)?$/
const CONTENT = '\t'
const UNCOMMITTED = /^0+$/
const HEAD = 'HEAD'
// a claim line carries its unique id, so low move/copy thresholds only match the same claim
const BLAME = ['blame', '--porcelain', '-w', '-M1', '-C1'] as const
const BATCH_CHECK = ['cat-file', '--batch-check=%(objectname) %(objecttype)'] as const

const MISSING = 'missing'

const objectOf = (name: string, line: string): GitObject | null => {
  if (line === `${name} ${MISSING}`) return null
  const m = OBJECT_LINE.exec(line)
  const type = z.enum(ObjectType).safeParse(m?.[2])
  if (m === null || !type.success) throw new Error(DRIFT_REFUSAL.unreadable(line))
  return { oid: m[1], type: type.data }
}

const objectsOf = async (git: GitRun, root: string, names: readonly string[]): Promise<(GitObject | null)[]> => {
  const lines = (await gitText(git, root, BATCH_CHECK, `${names.join('\n')}\n`)).split('\n')
  return names.map((name, i) => objectOf(name, lines[i] ?? ''))
}

export enum BasisKind { commit = 'commit', uncommitted = 'uncommitted', lost = 'lost' }
export type LineBasis = { kind: BasisKind.commit; commit: string } | { kind: BasisKind.uncommitted } | { kind: BasisKind.lost }

const LOST: LineBasis = { kind: BasisKind.lost }
const UNCOMMITTED_LINE: LineBasis = { kind: BasisKind.uncommitted }

export function parseBlame(porcelain: string): Map<string, LineBasis> {
  const bases = new Map<string, LineBasis>()
  let last: LineBasis | null = null
  for (const line of porcelain.split('\n')) {
    const header = BLAME_HEADER.exec(line)
    if (header !== null) last = UNCOMMITTED.test(header[1]) ? UNCOMMITTED_LINE : { kind: BasisKind.commit, commit: header[1] }
    if (!line.startsWith(CONTENT)) continue
    const id = claimIdOf(line.slice(CONTENT.length))
    if (id !== null && last !== null) bases.set(id, bases.has(id) ? LOST : last)
    last = null
  }
  return bases
}

const basisOf = (blame: ReadonlyMap<string, LineBasis> | null, id: string): LineBasis =>
  blame === null ? UNCOMMITTED_LINE : blame.get(id) ?? LOST

const memo = <V>(cache: Map<string, Promise<V>>, key: string, make: () => Promise<V>): Promise<V> => {
  const held = cache.get(key)
  if (held) return held
  const made = make()
  cache.set(key, made)
  made.catch(() => cache.delete(key))
  return made
}

enum TargetKind { file = 'file', directory = 'directory' }

function targetKind(root: string, anchorPath: string): TargetKind | null {
  try {
    const real = realpathSync(path.join(root, anchorPath))
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) return null
    return statSync(real).isDirectory() ? TargetKind.directory : TargetKind.file
  } catch (err) {
    if (codeOf(err) === Errno.ENOENT) return null
    throw err
  }
}

export interface Drift {
  anchorDigestAt(checkout: string, revision: string | null, anchor: KnowledgeAnchor): Promise<AnchorDigest>
  readings(root: string, claims: readonly KnowledgeClaim[]): Promise<ClaimReading[]>
}

export function createDrift(deps: { outlineOf: SourceOutline; git?: GitRun }): Drift {
  const git = deps.git ?? runGit
  const objects = new Map<string, Promise<GitObject | null>>()
  const blobs = new Map<string, Promise<SourceView>>()
  const trees = new Map<string, Promise<string>>()

  const lookup = async (root: string, name: string): Promise<GitObject | null> => (await objectsOf(git, root, [name]))[0] ?? null
  const objectAt = (root: string, revision: string, name: string): Promise<GitObject | null> =>
    FULL_SHA.test(revision) ? memo(objects, name, () => lookup(root, name)) : lookup(root, name)

  const blobView = (root: string, oid: string, anchorPath: string): Promise<SourceView> =>
    memo(blobs, `${oid}\0${path.extname(anchorPath)}`, async () => {
      const raw = await git(root, ['cat-file', ObjectType.blob, oid])
      return sourceView(raw, await deps.outlineOf(anchorPath, textOf(raw)))
    })

  const treeDigest = (root: string, revision: string, oid: string, dir: string): Promise<string> =>
    memo(trees, `${oid}\0${dir}`, async () =>
      directoryDigest((await gitText(git, root, ['ls-tree', '-r', '-z', '--name-only', revision, '--', dir])).split('\0').filter(p => p !== '')))

  const committedDigest = async (root: string, revision: string, anchor: KnowledgeAnchor): Promise<AnchorDigest> => {
    const target = normalizeEntity(anchor.path)
    const object = await objectAt(root, revision, `${revision}:${target}`)
    switch (object?.type) {
      case ObjectType.blob: return digestIn(await blobView(root, object.oid, anchor.path), anchor.symbol)
      case ObjectType.tree: return anchor.symbol === null ? { digest: await treeDigest(root, revision, object.oid, target), readable: true } : UNREADABLE
      default: return GONE
    }
  }

  const workingDigest = async (root: string, anchor: KnowledgeAnchor): Promise<AnchorDigest> => {
    const kind = targetKind(root, anchor.path)
    if (kind === null) return GONE
    if (kind === TargetKind.directory) {
      if (anchor.symbol !== null) return UNREADABLE
      const listed = await gitText(git, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', normalizeEntity(anchor.path)])
      return { digest: directoryDigest([...new Set(listed.split('\0'))].filter(p => p !== '' && existsSync(path.join(root, p)))), readable: true }
    }
    const raw = readBytes(path.join(root, anchor.path))
    if (raw === null) return GONE
    return digestIn(sourceView(raw, await deps.outlineOf(anchor.path, textOf(raw))), anchor.symbol)
  }

  const anchorDigestAt = (checkout: string, revision: string | null, anchor: KnowledgeAnchor): Promise<AnchorDigest> =>
    revision === null ? workingDigest(realpathSync(checkout), anchor) : committedDigest(checkout, revision, anchor)

  const blamesOf = async (root: string, locations: readonly string[]): Promise<Map<string, ReadonlyMap<string, LineBasis>>> => {
    const blames = new Map<string, ReadonlyMap<string, LineBasis>>()
    if (locations.length === 0) return blames
    const [head, ...found] = await objectsOf(git, root, [HEAD, ...locations.flatMap(l => [`${HEAD}:${l}`, `:${l}`])])
    if (head?.type !== ObjectType.commit) return blames
    await Promise.all(locations.map(async (location, i) => {
      if (found[2 * i] === null && found[2 * i + 1] === null) return
      blames.set(location, parseBlame(await gitText(git, root, [...BLAME, '--', location])))
    }))
    return blames
  }

  return {
    anchorDigestAt,
    async readings(root, claims) {
      const blames = await blamesOf(root, [...new Set(claims.map(c => c.location))])
      return Promise.all(claims.map(async claim => {
        const basis = basisOf(blames.get(claim.location) ?? null, claim.id)
        const anchors = await Promise.all(claim.anchors.map(async anchor => {
          const current = await workingDigest(root, anchor)
          if (basis.kind === BasisKind.uncommitted) return readingOf(anchor, current, current)
          return readingOf(anchor, basis.kind === BasisKind.commit ? await committedDigest(root, basis.commit, anchor) : GONE, current)
        }))
        return { claim, basis: basis.kind === BasisKind.commit ? basis.commit : null, anchors }
      }))
    },
  }
}
