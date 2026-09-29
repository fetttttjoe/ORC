# plugins/provider-ollama/src/index.ts

## Facts
- plugins/provider-ollama's createOllamaProvider defaults every model's cost to 0 (local inference is free) unless a per-model costOverride is supplied, and listOllamaModels excludes models whose /api/tags capabilities include 'embedding'. {580ov881 @plugins/provider-ollama/src/index.ts#createOllamaProvider #architecture-current}
