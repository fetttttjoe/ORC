# packages/cli/src/mcp-serve.ts

## Facts
- `orc mcp serve` (packages/cli/src/mcp-serve.ts) is door #2 of the two-doors model, serving orc over stdio to external MCP clients (e.g. Claude Code) under a launch-time --autonomy dial ('gated' default refuses approve, 'full' allows it attributed approvedBy: mcp) that the connected client cannot itself escalate. {zlcicu1a @packages/cli/src/mcp-serve.ts#mcpApproveTool #architecture-current}
