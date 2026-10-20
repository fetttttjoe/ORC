// Zero imports on purpose: the seq-ordering rule is a pure comparison

// Keep the FRESHER seq-stamped answer, not the last to arrive; equal seqs take the incoming one
export function newer<T extends { seq: number }>(held: T | undefined, incoming: T): T {
  return held !== undefined && held.seq > incoming.seq ? held : incoming
}
