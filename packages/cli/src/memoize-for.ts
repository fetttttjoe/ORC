export const memoizeFor = <T>(ms: number, fn: () => Promise<T>, now: () => number = Date.now): (() => Promise<T>) => {
  let held: { at: number; value: Promise<T> } | null = null
  return () => {
    if (held !== null && now() - held.at < ms) return held.value
    const value = fn()
    const entry = { at: now(), value }
    held = entry
    value.catch(() => { if (held === entry) held = null })
    return value
  }
}
