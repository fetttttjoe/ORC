# plugins/mcp-client/src/index.ts

## Why
- plugins/mcp-client's createMcpHub spawns MCP tool servers with StdioClientTransport configured with stderr: 'ignore', deliberately never surfacing a third-party server's stderr into orc's event log or vault log. {7jm5ns80 @plugins/mcp-client/src/index.ts#createMcpHub.ensureClient #architecture-current}
- plugins/mcp-client's createMcpHub re-evaluates the isTrusted predicate on every server spawn (not just once at plan validation), so a trust grant revoked or a declaration edited after a plan was approved blocks the next spawn. {hhct5abz @plugins/mcp-client/src/index.ts#createMcpHub.ensureClient #architecture-current}
