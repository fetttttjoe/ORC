# packages/graph-ui/web/src/lib/features/plan/plan-status.ts

## Why
- waveState reports running over failed while any step is still going, because the operator can still act on it, and an empty wave is pending, never completed. {64oc74eq @packages/graph-ui/web/src/lib/features/plan/plan-status.ts#waveState}
