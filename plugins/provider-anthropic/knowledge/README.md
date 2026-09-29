# plugins/provider-anthropic

## Facts
- Four sibling plugins under plugins/: three thin ModelProvider adapters (anthropic, openai, ollama) exporting a ProviderPlugin with a per-model COSTS table and auth/fetch injection, plus mcp-client's createMcpHub, a T1 stdio MCP tool-server host enforcing trust per spawn. {ggp165jm @plugins/provider-anthropic #architecture-current}
