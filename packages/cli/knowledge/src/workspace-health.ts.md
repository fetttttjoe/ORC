# packages/cli/src/workspace-health.ts

## Why
- projectHealth makes one log read for both the events and the fold, because Kernel.state() folds log.all() internally and calling it as well would read the whole log twice. {gq8jfdnu @packages/cli/src/workspace-health.ts#projectHealth}
