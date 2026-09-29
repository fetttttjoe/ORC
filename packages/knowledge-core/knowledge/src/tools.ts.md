# packages/knowledge-core/src/tools.ts

## Why
- SPECS in packages/knowledge-core/src/tools.ts holds each knowledge tool's description string; any other tool name mentioned inside a description must be interpolated from KnowledgeToolName (e.g. the search description references KnowledgeToolName.card via a template literal) rather than spelled as a literal, per the repo's no-scattered-string-literals rule. {5icv6n8m @packages/knowledge-core/src/tools.ts#SPECS #knowledge}
