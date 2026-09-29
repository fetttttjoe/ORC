# packages/cli/package.json

## Facts
- packages/cli/package.json lists fourteen @orc/* workspace dependencies — contracts, kernel, knowledge-core, knowledge-git, analyzer-agent, mcp-client, memory, graph-ui, ui-core, vault-projector, executor-api-loop, provider-anthropic, provider-openai, and provider-ollama — of which only @orc/graph-ui is imported lazily (a dynamic import inside the `graph` command); the rest, including knowledge-core and knowledge-git, are static imports. {i78j46ck @packages/cli/package.json @packages/cli/src/main.ts @packages/cli/src/runtime.ts}
