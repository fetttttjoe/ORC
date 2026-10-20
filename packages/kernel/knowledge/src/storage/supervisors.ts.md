# packages/kernel/src/storage/supervisors.ts

## Why
- claimSlot returns the lowest reclaimable slot id instead of a fresh uuid because DBOS recovers only its own executor's pending workflows, so a restarted supervisor needs the same id back to resume them. {14b6n1sc @packages/kernel/src/storage/supervisors.ts#claimSlot}
