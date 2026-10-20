# packages/contracts/src/plan-layering.ts

## Why
- Scheduler, wave rail and dependency graph share one layering, because two independent implementations can disagree on a cyclic plan and render different steps per surface. {62qot00a @packages/contracts/src/plan-layering.ts#stepRanks}
