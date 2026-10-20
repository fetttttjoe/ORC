# packages/cli/src/serve.ts

## Why
- startBootHeartbeat beats from slot claim until the runtime is built, because buildRuntime blocks on unbounded projection catch-up (measured: close to an hour after a wipe) during which an unbeaten slot reads stale and a second supervisor could steal it. {52bn9x2w @packages/cli/src/serve.ts#startBootHeartbeat}
