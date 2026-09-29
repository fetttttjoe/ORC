# plugins/provider-anthropic/src/index.ts

## Facts
- Each of plugins/provider-anthropic, plugins/provider-openai, plugins/provider-ollama, and plugins/mcp-client imports only '@orc/contracts' among @orc/* packages, with no direct import of plugins/trust.ts or any other plugin. {vrnb7f4c @plugins/provider-anthropic/src/index.ts @plugins/provider-openai/src/index.ts @plugins/provider-ollama/src/index.ts @plugins/mcp-client/src/index.ts #architecture-current}
- plugins/provider-anthropic's ProviderPlugin id 'anthropic' picks OAuth (Claude subscription) auth over API-key auth when ORC_ANTHROPIC_AUTH=oauth or CLAUDE_CODE_OAUTH_TOKEN is set, defaulting to ANTHROPIC_API_KEY otherwise. {udd3b5kz @plugins/provider-anthropic/src/index.ts#useOAuth #architecture-current}
