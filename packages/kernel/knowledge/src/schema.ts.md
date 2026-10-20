# packages/kernel/src/schema.ts

## Why
- supervisors is a heartbeat table rather than an exclusive lock because more than one live supervisor per project is a design goal and a lock cannot express two healthy ones. {qsx0m9it @packages/kernel/src/schema.ts#supervisors}
