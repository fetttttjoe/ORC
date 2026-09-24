export function freshIdSource(taken: Iterable<string>, next: () => string): () => string {
  const used = new Set(taken)
  return () => {
    for (;;) {
      const id = next()
      if (!used.has(id)) {
        used.add(id)
        return id
      }
    }
  }
}
