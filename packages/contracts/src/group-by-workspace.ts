// Zero imports on purpose: the kernel groups TaskNodes, the copilot groups graph nodes and the
// browser groups wire nodes — three element types, one rule. Two hand-written copies already
// disagreed on what happens to an item whose workspace is unknown; this drops it, and the caller
// that must show orphans asks for them separately (kernel `orphanTasks`).
export function groupByWorkspace<W extends { id: string }, T extends { workspaceId: string }>(
  workspaces: Iterable<W>,
  items: Iterable<T>,
): Array<{ workspace: W; items: T[] }> {
  const groups = new Map<string, { workspace: W; items: T[] }>()
  for (const w of workspaces) groups.set(w.id, { workspace: w, items: [] })
  for (const t of items) groups.get(t.workspaceId)?.items.push(t)
  return [...groups.values()]
}
