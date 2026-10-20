# packages/cli/src/mcp-serve.ts

## Facts
- `orc mcp serve` (packages/cli/src/mcp-serve.ts) is door #2 of the two-doors model, serving orc over stdio to external MCP clients (e.g. Claude Code) under a launch-time --autonomy dial ('gated' default refuses approve, 'full' allows it attributed approvedBy: mcp) that the connected client cannot itself escalate. {zlcicu1a @packages/cli/src/mcp-serve.ts#mcpApproveTool #architecture-current}

## Why
- orc mcp serve keeps stdout clean in two layers: bin.ts rebinds the console channels to stderr before boot, and the transport takes the real stdout while process.stdout.write is rerouted to stderr, so winston under a lazy DBOS boot cannot corrupt the protocol channel. {23gwzw3m @packages/cli/src/mcp-serve.ts#startMcpServe}
