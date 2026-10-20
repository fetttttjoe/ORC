// zero imports; drops items with an unknown workspace; orphans are asked for apart
export function groupByWorkspace<W extends { id: string }, T extends { workspaceId: string }>(
  workspaces: Iterable<W>,
  items: Iterable<T>,
): Array<{ workspace: W; items: T[] }> {
  const groups = new Map<string, { workspace: W; items: T[] }>()
  for (const w of workspaces) groups.set(w.id, { workspace: w, items: [] })
  for (const t of items) groups.get(t.workspaceId)?.items.push(t)
  return [...groups.values()]
}
