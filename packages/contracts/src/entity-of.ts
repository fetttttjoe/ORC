export const ROOT_ENTITY = '.'

export const pathSegments = (path: string): string[] =>
  path.replace(/\\/g, '/').split('/').filter(segment => segment !== '' && segment !== '.')

export const normalizeEntity = (path: string): string => pathSegments(path).join('/') || ROOT_ENTITY

export function entityChain(path: string, packageRoots: readonly string[]): string[] {
  const own = normalizeEntity(path)
  if (own === ROOT_ENTITY) return [ROOT_ENTITY]
  const parents = packageRoots
    .map(normalizeEntity)
    .filter(root => root !== ROOT_ENTITY && root !== own && underEntity(root, own))
    .sort((a, b) => pathSegments(b).length - pathSegments(a).length || a.localeCompare(b))
  return [...new Set([own, ...parents, ROOT_ENTITY])]
}

export const entitiesOf = (
  anchors: readonly { path: string }[],
  packageRoots: readonly string[],
): string[] => [...new Set(anchors.flatMap(anchor => entityChain(anchor.path, packageRoots)))]

export function underEntity(entity: string, path: string): boolean {
  if (entity === ROOT_ENTITY) return true
  const entityParts = pathSegments(entity)
  const pathParts = pathSegments(path)
  return entityParts.length <= pathParts.length
    && entityParts.every((segment, index) => segment === pathParts[index])
}
