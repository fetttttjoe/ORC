# plugins/provider-openai/src/index.ts

## Why
- listOpenAIModels rejects when the API cannot answer, because openai has no static cost table and a swallowed failure would read as reachable-and-empty and overwrite the real catalog with models: []. {b5iik519 @plugins/provider-openai/src/index.ts#listOpenAIModels}
