// Block style plus trimEnd is load-bearing: flow style glues the closing fence to content
export function frontmatter(obj: Record<string, unknown>): string {
  return `---\n${Bun.YAML.stringify(obj, null, 2).trimEnd()}\n---\n`
}
