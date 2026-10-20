# packages/ui-core/src/actions.ts

## Why
- OrcActions.reply accepts a projectId because the graph UI lists every project and fencing answers to the home project showed questions the user could not answer; it binds to no runtime since the append only unblocks the parked step. {ajw5esgn @packages/ui-core/src/actions.ts#OrcActions}
- OrcActions.run only records a run request and returns the log seq it was recorded at, because the supervisor holding the runtime starts the workflow; a watcher must tail from that seq or replay the task's whole history. {kji72lgb @packages/ui-core/src/actions.ts#OrcActions}
