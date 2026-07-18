// The ONE frontmatter builder for the whole vault (plan files, task files, memory notes).
// Block style (Bun.YAML.stringify(obj, null, 2)) + trimEnd is load-bearing: flow style glues
// the closing fence to content and breaks Obsidian frontmatter parsing (M4a Task 4/5 bug).
export function frontmatter(obj: Record<string, unknown>): string {
  return `---\n${Bun.YAML.stringify(obj, null, 2).trimEnd()}\n---\n`
}
