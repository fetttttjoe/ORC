# packages/ui-core/src/graph.ts

## Facts
- buildGraph in packages/ui-core/src/graph.ts is the single events→graph projection used by every full load and, via diffGraphs, every incremental patch. {peltcndj @packages/ui-core/src/graph.ts#buildGraph #architecture-current}

## Why
- buildGraph dedups artifact nodes by node id and keeps the newest, because state.artifacts is append-only and a path written twice would produce two same-id nodes that make diffGraphs re-emit the node on every event. {bi93p5s7 @packages/ui-core/src/graph.ts#buildGraph}
