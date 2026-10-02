const WRAPPED_START = /^[`'"([{<*]+/
const WRAPPED_END = /[`'"\])}>.,;:!?*]+$/
const LOCATION_SUFFIX = /[#:]/
const GLOB_CHAR = /[*?[{]/

const pathIn = (token: string): string | null => {
  const bare = token.replace(WRAPPED_START, '').replace(WRAPPED_END, '')
  const [file = ''] = bare.split(LOCATION_SUFFIX, 1)
  const path = file.replace(WRAPPED_END, '')
  return path.includes('/') ? path : null
}

export function namedPaths(text: string): string[] {
  return [...new Set(text.split(/\s+/).flatMap(token => pathIn(token) ?? []))]
}

export function zonePrefix(glob: string): string | null {
  const at = glob.search(GLOB_CHAR)
  if (at === -1) return glob
  const folder = glob.slice(0, at).lastIndexOf('/')
  return folder <= 0 ? null : glob.slice(0, folder)
}

export const preloadQuery = (title: string, instructions: string, maxChars: number): string => `${title}\n${instructions}`.slice(0, maxChars)
