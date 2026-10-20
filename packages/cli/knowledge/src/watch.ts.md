# packages/cli/src/watch.ts

## Why
- watchSubtree takes `since` as the seq of the run_requested it belongs to and settles only on events later than it, because otherwise `orc retry` settles at once on the very stopped status it is asking to leave. {40qysr5b @packages/cli/src/watch.ts#watchSubtree}
