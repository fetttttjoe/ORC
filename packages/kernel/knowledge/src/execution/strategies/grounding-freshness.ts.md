# packages/kernel/src/execution/strategies/grounding-freshness.ts

## Facts
- decideGroundingFreshness in packages/kernel/src/execution/strategies/grounding-freshness.ts is a pure function over a structural GroundingSource interface (head/notes/commitsSince/changedPaths) with no git, store or plugins/memory import, letting dbos-port compute the freshness verdict once inside a checkpoint and replay it deterministically. {6w09t8ex @packages/kernel/src/execution/strategies/grounding-freshness.ts#decideGroundingFreshness @packages/kernel/src/execution/strategies/grounding-freshness.ts#GroundingSource #architecture-current}
