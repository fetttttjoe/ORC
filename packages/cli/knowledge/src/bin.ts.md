# packages/cli/src/bin.ts

## Facts
- packages/cli/src/bin.ts is the CLI process entry point: it lazily builds the DBOS runtime only when a command's portFactory is actually invoked, and rebinds console.log/info/debug to console.error when argv is `mcp serve` so stdout carries only MCP protocol frames. {pe12q6ew @packages/cli/src/bin.ts #architecture-current}
- packages/cli/src/bin.ts calls isDatabaseUnreachable (the renamed isConnectionRefused) at both of its call sites, so a connect timeout is reported as an unreachable database the same way a refused connection is. {vxj4bnac @packages/cli/src/bin.ts @packages/kernel/src/errors.ts#isDatabaseUnreachable #postgres-connect-timeout-and-unreachable}
