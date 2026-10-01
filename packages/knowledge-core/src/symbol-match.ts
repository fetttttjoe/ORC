export type SymbolMatch = { name: string } | { closest: string[] }

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]
}

const lastPart = (name: string): string => name.slice(name.lastIndexOf('.') + 1)

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function matchSymbol(names: readonly string[], wanted: string, limit: number): SymbolMatch {
  const distinct = [...new Set(names)]
  if (distinct.includes(wanted)) return { name: wanted }
  const suffixed = distinct.filter(name => name.endsWith(`.${wanted}`))
  if (suffixed.length === 1) return { name: suffixed[0] }
  const ranked = distinct.map(name => ({
    name,
    tier: suffixed.includes(name) ? 0 : 1,
    distance: Math.min(editDistance(wanted, name), editDistance(wanted, lastPart(name))),
  }))
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance || byName(a.name, b.name))
  return { closest: ranked.slice(0, limit).map(r => r.name) }
}
