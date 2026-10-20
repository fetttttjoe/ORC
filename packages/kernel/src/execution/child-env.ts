// process.env holds provider keys and DB credentials; a child gets only this allowlist.
export const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'])
    if (process.env[k] !== undefined) out[k] = process.env[k]
  return out
}
