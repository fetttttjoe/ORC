# packages/cli/package.json

## Facts
- packages/cli/package.json lists fourteen @orc/* workspace dependencies — contracts, kernel, knowledge-core, knowledge-git, structure-treesitter, analyzer-agent, mcp-client, graph-ui, ui-core, vault-projector, executor-api-loop, provider-anthropic, provider-openai, and provider-ollama — of which only @orc/graph-ui is imported lazily (a dynamic import inside the `graph` command); the rest, including knowledge-core, knowledge-git and structure-treesitter, are static imports. {21jh58zb @packages/cli/package.json @packages/cli/src/serve-commands.ts @packages/cli/src/runtime.ts}
