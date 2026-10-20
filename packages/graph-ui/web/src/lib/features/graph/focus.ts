
// Follow link DIRECTION only: an undirected walk reaches every task sharing a hub, dimming nothing
export function focusReach(root: string, links: Iterable<{ source: string; target: string }>): Set<string> {
  const out = new Map<string, string[]>()
  for (const l of links) {
    const targets = out.get(l.source)
    if (targets) targets.push(l.target)
    else out.set(l.source, [l.target])
  }
  const keep = new Set<string>([root])
  const queue = [root]
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const target of out.get(next) ?? []) {
      if (keep.has(target)) continue
      keep.add(target)
      queue.push(target)
    }
  }
  return keep
}
