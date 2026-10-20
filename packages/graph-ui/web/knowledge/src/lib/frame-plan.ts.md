# packages/graph-ui/web/src/lib/frame-plan.ts

## Facts
- web/src/lib/frame-plan.ts's planFrame decides SSE seq-regression and backfill purely (no EventSource dependency), and the caller must discard the graph/ledger portions of a frame and resync from a fresh snapshot when regression is true. {ia1j4ahq @packages/graph-ui/web/src/lib/frame-plan.ts#planFrame @packages/graph-ui/web/src/lib/sse.ts #architecture-current}

## Why
- A later id-less frame needs no special case, because the browser keeps the last-event-id buffer across id-less messages, so it carries the held id: no regression, and seq re-assigns the value already held. {tl2han8j @packages/graph-ui/web/src/lib/frame-plan.ts#planFrame}
