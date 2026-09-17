// Never the orchestrator's full process.env: provider API keys and DB credentials live there and
// must not reach a child process (a `bun test` an exec step runs, or the `git` tree-fingerprint
// shells out to). A minimal surface (PATH to find the binary, HOME for tool caches, locale/tmp).
export const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'])
    if (process.env[k] !== undefined) out[k] = process.env[k]
  return out
}
