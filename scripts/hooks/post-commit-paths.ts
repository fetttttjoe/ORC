// PURE: git-plumbing text in, trimmed non-blank path list out; no process, no filesystem
export function parseChangedPaths(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}
