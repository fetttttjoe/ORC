import { normalizeEntity, pathSegments, ROOT_ENTITY, underEntity } from '@orc/contracts/entity-of'

export const README_BUCKET = 'README.md'
export const ROOT_TITLE = 'project'
const BUCKET_SUFFIX = '.md'

export interface AnchorKind { path: string; isDirectory: boolean }

const join = (...parts: string[]): string => parts.filter(part => part !== '' && part !== ROOT_ENTITY).join('/')

export function packageRootOf(path: string, packageRoots: readonly string[]): string {
  const own = normalizeEntity(path)
  let best = ROOT_ENTITY
  for (const root of packageRoots.map(normalizeEntity)) {
    if (root === ROOT_ENTITY || !underEntity(root, own)) continue
    if (best === ROOT_ENTITY || pathSegments(root).length > pathSegments(best).length) best = root
  }
  return best
}

export function bucketOf(first: AnchorKind | null, packageRoots: readonly string[], dirName: string): string {
  if (first === null) return join(dirName, README_BUCKET)
  const root = packageRootOf(first.path, packageRoots)
  if (first.isDirectory) return join(root, dirName, README_BUCKET)
  const relative = pathSegments(first.path).slice(pathSegments(root).length).join('/')
  return join(root, dirName, `${relative}${BUCKET_SUFFIX}`)
}

const insideKnowledge = (location: string, packageRoots: readonly string[], dirName: string): { root: string; rest: string[] } | null => {
  const root = packageRootOf(location, packageRoots)
  const [head, ...rest] = pathSegments(location).slice(pathSegments(root).length)
  return head === dirName && rest.length > 0 ? { root, rest } : null
}

export function isBucket(location: string, packageRoots: readonly string[], dirName: string): boolean {
  return location.endsWith(BUCKET_SUFFIX) && insideKnowledge(location, packageRoots, dirName) !== null
}

export function titleOf(location: string, packageRoots: readonly string[], dirName: string): string {
  const inside = insideKnowledge(location, packageRoots, dirName)
  if (inside === null) return normalizeEntity(location)
  const rest = inside.rest.join('/')
  if (rest === README_BUCKET) return inside.root === ROOT_ENTITY ? ROOT_TITLE : inside.root
  return join(inside.root, rest.slice(0, -BUCKET_SUFFIX.length))
}
