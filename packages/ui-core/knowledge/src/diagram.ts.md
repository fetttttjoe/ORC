# packages/ui-core/src/diagram.ts

## Why
- diagram.ts's todoWaves delegates step layering to @orc/contracts/plan-layering's layerSteps so the request view and the browser's dependency graph never disagree on wave order for cyclic plans. {ogxlliep @packages/ui-core/src/diagram.ts#todoWaves #architecture-current}
