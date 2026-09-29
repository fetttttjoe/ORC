# packages/cli/src/bin.ts

## Facts
- packages/cli/src/bin.ts is the CLI process entry point: it lazily builds the DBOS runtime only when a command's portFactory is actually invoked, and rebinds console.log/info/debug to console.error when argv is `mcp serve` so stdout carries only MCP protocol frames. {pe12q6ew @packages/cli/src/bin.ts #architecture-current}
