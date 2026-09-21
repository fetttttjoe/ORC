export const MAX_CAUSE_DEPTH = 8

export const errField = (err: unknown, key: string): unknown =>
  typeof err === 'object' && err !== null && key in err ? Reflect.get(err, key) : undefined

// `lastError` preferred over `cause`, each guarded against self-reference on its own — a
// self-referencing `lastError` still falls back to `cause` rather than ending the walk.
export function* errorChainNodes(err: unknown, maxDepth: number = MAX_CAUSE_DEPTH): Generator<unknown> {
  const seen = new Set<unknown>()
  let node = err
  let depth = 0
  while (node !== undefined && node !== null && depth < maxDepth && !seen.has(node)) {
    seen.add(node)
    yield node
    const lastError = errField(node, 'lastError')
    const cause = errField(node, 'cause')
    node = lastError !== undefined && lastError !== node ? lastError
      : cause !== undefined && cause !== node ? cause
      : undefined
    depth += 1
  }
}
