# packages/cli/src/door-kernel.ts

## Why
- packages/cli/src/door-kernel.ts's WorkspaceDoor interface deliberately excludes the mutating Kernel type, exposing only workspaces/reads/config/listWorkspaces, so a handler built against it cannot append an event without an origin. {t3efgx6f @packages/cli/src/door-kernel.ts#WorkspaceDoor #architecture-current}
