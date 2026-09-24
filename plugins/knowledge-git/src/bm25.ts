export interface RankedDocument { id: string; text: string }
export interface Scored { id: string; score: number }

const K1 = 1.2
const B = 0.75
const CAMEL_BOUNDARY = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u

export function tokenize(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u)
    .flatMap(word => { const parts = word.split(CAMEL_BOUNDARY); return parts.length > 1 ? [word, ...parts] : [word] })
    .map(word => word.toLowerCase())
    .filter(word => word.length >= 2)
}

export function bm25(documents: readonly RankedDocument[], query: string, limit: number): Scored[] {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || documents.length === 0) return []
  const docs = documents.map(d => ({ id: d.id, tokens: tokenize(d.text) }))
  const average = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length || 1
  const frequency = new Map(terms.map(t => [t, docs.filter(d => d.tokens.includes(t)).length]))
  return docs
    .map(d => {
      let score = 0
      for (const term of terms) {
        const containing = frequency.get(term) ?? 0
        const count = d.tokens.filter(token => token === term).length
        if (containing === 0 || count === 0) continue
        const idf = Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5))
        score += idf * (count * (K1 + 1)) / (count + K1 * (1 - B + B * d.tokens.length / average))
      }
      return { id: d.id, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
}
