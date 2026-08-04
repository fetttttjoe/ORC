// PURE: raw git-plumbing text in (e.g. `git show --name-only --format= HEAD`'s stdout — the same
// spelling commit-tool.ts's committedPaths already uses), trimmed/blank-filtered path list out. No
// git process spawned here, no filesystem access — the hook script (scripts/hooks/post-commit)
// owns capturing the text; this owns only parsing it, so it stays unit-testable with plain strings.
export function parseChangedPaths(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}
