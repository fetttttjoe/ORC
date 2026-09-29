# plugins/memory/src/budget.ts

## Facts
- applyBudget and fitMemoryNoteToBudget in plugins/memory/src/budget.ts trim a MemoryNote to a token budget (approxTokens approximates tokens as chars/4) by bisecting summary/rationale/body text and refilling list fields (categories, tags, links, paths, claims, ...) item by item, so agent-facing tool responses stay within a caller-given budget. {tar148lt @plugins/memory/src/budget.ts#applyBudget #architecture-current}
