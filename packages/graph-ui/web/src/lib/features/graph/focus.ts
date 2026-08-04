// The focus walk, pure and link-shape-only: which nodes count as "this request's work". Zero
// runtime imports; focus.test.ts pins the reachability contract.

/**
 * Nodes reachable from `root` following link DIRECTION (source → target) only.
 *
 * Direction is what keeps focus meaningful. Every edge the projection draws points outward from
 * the work: task → step (plan), task → child task, step/task → artifact, task → model (uses),
 * task → note (wrote), note → cited note. An undirected walk — the previous implementation —
 * flowed BACKWARD through shared hubs: any other task using the same model was two hops away,
 * so the "focus" set was the entire connected component and focusing visibly dimmed nothing.
 */
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
