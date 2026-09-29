# plugins/memory/src/rank.ts

## Facts
- rankNeighbors in plugins/memory/src/rank.ts scores a note's graph neighborhood by bounded best-score relaxation over typed link edges, using DEFAULT_LINK_WEIGHTS per LinkKind, a decay of 0.6 per depth, a score floor of 0.05, and a result cap of 20. {lnvmc00y @plugins/memory/src/rank.ts#rankNeighbors #architecture-current}
