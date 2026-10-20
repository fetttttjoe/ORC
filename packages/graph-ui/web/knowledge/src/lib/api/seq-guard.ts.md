# packages/graph-ui/web/src/lib/api/seq-guard.ts

## Why
- newer keeps the higher-seq answer rather than the last to arrive, because an SSE touch can start a refetch that resolves before an earlier in-flight one; equal seqs take the incoming answer so the client is not pinned to the first held. {pjpkjxns @packages/graph-ui/web/src/lib/api/seq-guard.ts#newer}
